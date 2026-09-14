import type { Worksheet } from 'exceljs';

import { formatCellAddress } from '../shared/cell-reference.js';
import { resolveDatasetContext } from '../shared/exceljs/dataset-context.js';
import { parseExcelCellValue, type ParsedExcelCellValue } from '../shared/exceljs/cell-value.js';
import { resolveHeaderColumn, type ExcelHeaderColumn } from '../shared/exceljs/header.js';
import {
  executeExcelOperation,
  openWorkbook,
  requireWorksheet,
  throwIfAborted,
} from '../shared/exceljs/workbook-io.js';
import { hasActualValueInRow } from '../shared/exceljs/used-range.js';
import type { FilterDataInput, FilterDataResult } from './contracts.js';
import type { ExcelFilterConnector } from './connector.js';
import {
  createMatchedRangeAccumulator,
  finalizeMatchedRanges,
  recordMatchedRow,
} from './filter-engine.js';
import { filterDataInputSchema } from './schemas.js';
import {
  evaluatePredicates,
  type ResolvedExcelPredicate,
} from '../shared/query/predicate-engine.js';

export class ExcelJsFilterAdapter implements ExcelFilterConnector {
  /** Filters value-based worksheet rows with typed exact-header conditions. */
  async filterData(input: FilterDataInput, signal?: AbortSignal): Promise<FilterDataResult> {
    const validated = filterDataInputSchema.parse(input);

    return executeExcelOperation('filterData', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = requireWorksheet(workbook, validated.sheetName);
      const dataset = resolveDatasetContext(
        worksheet,
        validated.range,
        signal,
        'filterData',
      );
      const predicates: ResolvedExcelPredicate[] = validated.conditions.map((predicate) => ({
        predicate,
        columnIndex: resolveHeaderColumn(predicate.column, dataset.header, validated.sheetName)
          .columnIndex,
      }));
      const sourceColumns = uniqueColumns(
        predicates.map((predicate) => ({
          name: predicate.predicate.column,
          columnIndex: predicate.columnIndex,
        })),
      );
      const accumulator = createMatchedRangeAccumulator();
      let sourceRowCount = 0;

      if (dataset.range !== undefined && dataset.dataStartRow !== null) {
        for (let row = dataset.dataStartRow; row <= dataset.range.end.row; row += 1) {
          throwIfAborted(signal, 'filterData');
          if (
            !hasActualValueInRow(
              worksheet,
              row,
              dataset.range.start.column,
              dataset.range.end.column,
            )
          ) {
            continue;
          }
          sourceRowCount += 1;

          const rowValues = readSelectedValues(worksheet, row, sourceColumns);
          if (
            evaluatePredicates(rowValues, predicates, validated.logic, (predicate) => ({
              sheetName: validated.sheetName,
              column: predicate.predicate.column,
              address: formatCellAddress({ row, column: predicate.columnIndex }),
              operator: predicate.predicate.operator,
            }))
          ) {
            recordMatchedRow(accumulator, row);
          }
        }
      }

      return {
        sheetName: worksheet.name,
        sourceRowCount,
        matchedRowCount: accumulator.matchedRowCount,
        matchedRanges: finalizeMatchedRanges(accumulator),
      };
    });
  }
}

/** Removes duplicate source columns so repeated conditions read one cell once per row. */
function uniqueColumns(columns: readonly ExcelHeaderColumn[]): readonly ExcelHeaderColumn[] {
  const seen = new Set<number>();
  const unique: ExcelHeaderColumn[] = [];
  for (const column of columns) {
    if (seen.has(column.columnIndex)) {
      continue;
    }
    seen.add(column.columnIndex);
    unique.push(column);
  }
  return unique;
}

/** Reads and parses each required source cell once for one data row. */
function readSelectedValues(
  worksheet: Worksheet,
  row: number,
  columns: readonly ExcelHeaderColumn[],
): ReadonlyMap<number, ParsedExcelCellValue> {
  const values = new Map<number, ParsedExcelCellValue>();
  for (const column of columns) {
    values.set(
      column.columnIndex,
      parseExcelCellValue(worksheet.findCell(row, column.columnIndex)?.value),
    );
  }
  return values;
}
