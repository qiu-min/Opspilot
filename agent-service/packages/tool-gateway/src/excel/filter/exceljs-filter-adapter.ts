import type { Worksheet } from 'exceljs';

import { formatCellAddress } from '../shared/cell-reference.js';
import { parseExcelCellValue, type ParsedExcelCellValue } from '../shared/exceljs/cell-value.js';
import {
  findHeaderContext,
  resolveHeaderColumn,
  type ExcelHeaderColumn,
} from '../shared/exceljs/header.js';
import {
  executeExcelOperation,
  openWorkbook,
  requireWorksheet,
  throwIfAborted,
} from '../shared/exceljs/workbook-io.js';
import { findUsedRange, hasActualValueInRow } from '../shared/exceljs/used-range.js';
import type { FilterDataInput, FilterDataResult } from './contracts.js';
import type { ExcelFilterConnector } from './connector.js';
import {
  createMatchedRangeAccumulator,
  finalizeMatchedRanges,
  matchesConditions,
  recordMatchedRow,
  type ResolvedFilterCondition,
} from './filter-engine.js';
import { filterDataInputSchema } from './schemas.js';

export class ExcelJsFilterAdapter implements ExcelFilterConnector {
  /** Filters value-based worksheet rows with typed exact-header conditions. */
  async filterData(input: FilterDataInput, signal?: AbortSignal): Promise<FilterDataResult> {
    const validated = filterDataInputSchema.parse(input);

    return executeExcelOperation('filterData', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = requireWorksheet(workbook, validated.sheetName);
      const usedRange = findUsedRange(worksheet, 'values');
      const header = findHeaderContext(worksheet, usedRange, signal, 'filterData');
      const conditions: ResolvedFilterCondition[] = validated.conditions.map((condition) => ({
        condition,
        columnIndex: resolveHeaderColumn(condition.column, header, validated.sheetName).columnIndex,
      }));
      const sourceColumns = uniqueColumns(
        conditions.map((condition) => ({
          name: condition.condition.column,
          columnIndex: condition.columnIndex,
        })),
      );
      const accumulator = createMatchedRangeAccumulator();
      let sourceRowCount = 0;

      if (usedRange !== undefined) {
        for (let row = header.headerRow + 1; row <= usedRange.end.row; row += 1) {
          throwIfAborted(signal, 'filterData');
          if (!hasActualValueInRow(worksheet, row, usedRange.start.column, usedRange.end.column)) {
            continue;
          }
          sourceRowCount += 1;

          const rowValues = readSelectedValues(worksheet, row, sourceColumns);
          if (
            matchesConditions(rowValues, conditions, validated.logic, (condition) => ({
              sheetName: validated.sheetName,
              column: condition.condition.column,
              address: formatCellAddress({ row, column: condition.columnIndex }),
              operator: condition.condition.operator,
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
