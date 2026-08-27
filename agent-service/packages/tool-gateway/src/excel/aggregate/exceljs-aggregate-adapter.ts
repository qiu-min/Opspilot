import type { Worksheet } from 'exceljs';

import { formatCellAddress, formatCellRange, type CellRange } from '../shared/cell-reference.js';
import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../shared/errors.js';
import {
  executeExcelOperation,
  openWorkbook,
  requireWorksheet,
  throwIfAborted,
} from '../shared/exceljs/workbook-io.js';
import { headerText } from '../shared/exceljs/cell-value.js';
import {
  findUsedRange,
  hasActualCellValue,
  hasActualValueInRow,
} from '../shared/exceljs/used-range.js';
import type {
  AggregateDataInput,
  AggregateDataResult,
  AggregateMetric,
  AggregateOperation,
  AggregateResultColumn,
} from './contracts.js';
import {
  createGroupAccumulator,
  createTypedGroupKey,
  createValueContext,
  finalizeMetricAccumulator,
  toGroupValue,
  toSourceCellValue,
  updateMetricAccumulator,
  type GroupAccumulator,
  type SourceCellValue,
} from './aggregation-engine.js';
import type { ExcelAggregateConnector } from './connector.js';
import { aggregateDataInputSchema } from './schemas.js';

export class ExcelJsAggregateAdapter implements ExcelAggregateConnector {
  /** Aggregates worksheet rows by selected columns and metrics. */
  async aggregateData(
    input: AggregateDataInput,
    signal?: AbortSignal,
  ): Promise<AggregateDataResult> {
    const validated = aggregateDataInputSchema.parse(input);

    return executeExcelOperation('aggregateData', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = requireWorksheet(workbook, validated.sheetName);
      const usedRange = findUsedRange(worksheet, 'values');
      const plan = createAggregationPlan(worksheet, usedRange, validated, signal);
      const groups = new Map<string, GroupAccumulator>();

      if (plan.groupBy.length === 0) {
        groups.set(createTypedGroupKey([]), createGroupAccumulator([], plan.metrics.length));
      }

      let sourceRowCount = 0;
      if (usedRange !== undefined) {
        for (let row = plan.headerRow + 1; row <= usedRange.end.row; row += 1) {
          throwIfAborted(signal, 'aggregateData');
          if (!hasActualValueInRow(worksheet, row, usedRange.start.column, usedRange.end.column)) {
            continue;
          }
          sourceRowCount += 1;

          const rowValues = readSelectedValues(worksheet, row, plan.sourceColumns);
          const groupValues = plan.groupBy.map((column) =>
            toGroupValue(
              rowValues.get(column.columnIndex),
              createValueContext(
                validated.sheetName,
                column.name,
                row,
                column.columnIndex,
                'groupBy',
              ),
            ),
          );
          const groupKey = createTypedGroupKey(groupValues);
          const group =
            groups.get(groupKey) ?? createGroupAccumulator(groupValues, plan.metrics.length);
          groups.set(groupKey, group);

          for (let index = 0; index < plan.metrics.length; index += 1) {
            const metric = plan.metrics[index];
            if (metric === undefined) {
              continue;
            }

            updateMetricAccumulator(
              group.metrics[index],
              metric.operation,
              rowValues.get(metric.column.columnIndex),
              createValueContext(
                validated.sheetName,
                metric.column.name,
                row,
                metric.column.columnIndex,
                metric.operation,
              ),
            );
          }
        }
      }

      const rows = [...groups.values()].map((group) => [
        ...group.groupValues,
        ...group.metrics.map((metric, index) =>
          finalizeMetricAccumulator(metric, plan.metrics[index]?.operation),
        ),
      ]);

      return {
        sheetName: worksheet.name,
        columns: plan.resultColumns,
        rows,
        sourceRowCount,
        resultRowCount: rows.length,
      };
    });
  }
}

interface ResolvedColumn {
  readonly name: string;
  readonly columnIndex: number;
}

interface ResolvedMetric {
  readonly column: ResolvedColumn;
  readonly operation: AggregateOperation;
}

interface AggregationPlan {
  readonly headerRow: number;
  readonly groupBy: readonly ResolvedColumn[];
  readonly metrics: readonly ResolvedMetric[];
  readonly sourceColumns: readonly ResolvedColumn[];
  readonly resultColumns: readonly AggregateResultColumn[];
}

interface HeaderContext {
  readonly headerRow: number;
  readonly availableColumns: readonly string[];
  readonly matches: ReadonlyMap<string, readonly ResolvedColumn[]>;
}

/** Resolves all requested columns and builds the single-pass aggregation plan. */
function createAggregationPlan(
  worksheet: Worksheet,
  usedRange: CellRange | undefined,
  input: {
    readonly sheetName: string;
    readonly groupBy: readonly string[];
    readonly metrics: readonly AggregateMetric[];
  },
  signal: AbortSignal | undefined,
): AggregationPlan {
  const header = createHeaderContext(worksheet, usedRange, input.sheetName, signal);
  const groupBy = input.groupBy.map((column) => resolveColumn(column, header, input.sheetName));
  const metrics = input.metrics.map((metric) => ({
    column: resolveColumn(metric.column, header, input.sheetName),
    operation: metric.operation,
  }));
  const resultColumns = createResultColumns(groupBy, input.metrics);
  const sourceColumns = uniqueColumns([...groupBy, ...metrics.map((metric) => metric.column)]);

  return {
    headerRow: header.headerRow,
    groupBy,
    metrics,
    sourceColumns,
    resultColumns,
  };
}

/** Finds the value-based header row and indexes its exact header names. */
function createHeaderContext(
  worksheet: Worksheet,
  usedRange: CellRange | undefined,
  sheetName: string,
  signal: AbortSignal | undefined,
): HeaderContext {
  if (usedRange === undefined) {
    return {
      headerRow: 0,
      availableColumns: [],
      matches: new Map(),
    };
  }

  let headerRow: number | undefined;
  for (let row = usedRange.start.row; row <= usedRange.end.row; row += 1) {
    throwIfAborted(signal, 'aggregateData');
    if (hasActualValueInRow(worksheet, row, usedRange.start.column, usedRange.end.column)) {
      headerRow = row;
      break;
    }
  }

  if (headerRow === undefined) {
    return {
      headerRow: usedRange.start.row,
      availableColumns: [],
      matches: new Map(),
    };
  }

  const matches = new Map<string, ResolvedColumn[]>();
  const availableColumns: string[] = [];
  for (let column = usedRange.start.column; column <= usedRange.end.column; column += 1) {
    const cell = worksheet.findCell(headerRow, column);
    if (!cell || !hasActualCellValue(cell)) {
      continue;
    }

    const name = headerText(cell.value);
    if (name === null) {
      continue;
    }

    availableColumns.push(name);
    const columns = matches.get(name) ?? [];
    columns.push({ name, columnIndex: column });
    matches.set(name, columns);
  }

  return { headerRow, availableColumns, matches };
}

/** Resolves one requested column against the exact header index. */
function resolveColumn(name: string, header: HeaderContext, sheetName: string): ResolvedColumn {
  const matches = header.matches.get(name) ?? [];
  if (matches.length === 0) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.COLUMN_NOT_FOUND,
      `Column '${name}' was not found in worksheet '${sheetName}'`,
      {
        sheetName,
        column: name,
        availableColumns: header.availableColumns,
        matches: [],
      },
    );
  }

  if (matches.length > 1) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.AMBIGUOUS_COLUMN,
      `Column '${name}' matched multiple headers in worksheet '${sheetName}'`,
      {
        sheetName,
        column: name,
        availableColumns: header.availableColumns,
        matches: matches.map((match) =>
          formatCellAddress({ row: header.headerRow, column: match.columnIndex }),
        ),
      },
    );
  }

  return matches[0]!;
}

/** Builds and validates the group and metric output columns. */
function createResultColumns(
  groupBy: readonly ResolvedColumn[],
  metrics: readonly AggregateMetric[],
): readonly AggregateResultColumn[] {
  const columns: AggregateResultColumn[] = groupBy.map((column) => ({
    name: column.name,
    kind: 'group',
    sourceColumn: column.name,
  }));

  for (const metric of metrics) {
    const name = metric.alias ?? `${metric.column}.${metric.operation}`;
    columns.push({
      name,
      kind: 'metric',
      sourceColumn: metric.column,
      operation: metric.operation,
    });
  }

  const seen = new Set<string>();
  for (const column of columns) {
    if (seen.has(column.name)) {
      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.DUPLICATE_OUTPUT_COLUMN,
        `Aggregate output column '${column.name}' is duplicated`,
        { name: column.name },
      );
    }
    seen.add(column.name);
  }

  return columns;
}

/** Removes duplicate source columns so each selected cell is read once per row. */
function uniqueColumns(columns: readonly ResolvedColumn[]): readonly ResolvedColumn[] {
  const seen = new Set<number>();
  const unique: ResolvedColumn[] = [];
  for (const column of columns) {
    if (seen.has(column.columnIndex)) {
      continue;
    }
    seen.add(column.columnIndex);
    unique.push(column);
  }
  return unique;
}

/** Reads each required source column once for one data row. */
function readSelectedValues(
  worksheet: Worksheet,
  row: number,
  columns: readonly ResolvedColumn[],
): ReadonlyMap<number, SourceCellValue> {
  const values = new Map<number, SourceCellValue>();
  for (const column of columns) {
    values.set(
      column.columnIndex,
      toSourceCellValue(worksheet.findCell(row, column.columnIndex)?.value),
    );
  }
  return values;
}
