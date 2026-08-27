import type { Worksheet } from 'exceljs';

import { formatCellAddress, formatCellRange, type CellRange } from '../shared/cell-reference.js';
import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../shared/errors.js';
import {
  executeExcelOperation,
  openWorkbook,
  requireWorksheet,
  throwIfAborted,
} from '../shared/exceljs/workbook-io.js';
import { findUsedRange, hasActualCellValue } from '../shared/exceljs/used-range.js';
import { headerText } from '../discovery/type-inference.js';
import type {
  AggregateDataInput,
  AggregateDataResult,
  AggregateGroupValue,
  AggregateMetric,
  AggregateMetricValue,
  AggregateOperation,
  AggregateResultColumn,
} from './contracts.js';
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
              metric,
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

interface GroupAccumulator {
  readonly groupValues: readonly AggregateGroupValue[];
  readonly metrics: MetricAccumulator[];
}

interface MetricAccumulator {
  sum: number;
  count: number;
  numericCount: number;
  min: number | null;
  max: number | null;
}

type AggregateScalar = Exclude<AggregateGroupValue, null>;

type SourceCellValue =
  | { readonly kind: 'empty' }
  | { readonly kind: 'value'; readonly value: AggregateScalar }
  | { readonly kind: 'formula'; readonly hasResult: boolean; readonly result: unknown }
  | { readonly kind: 'unsupported'; readonly valueType: string };

interface ValueContext {
  readonly sheetName: string;
  readonly column: string;
  readonly address: string;
  readonly operation: AggregateOperation | 'groupBy';
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

/** Converts an ExcelJS cell value into an aggregation source value. */
function toSourceCellValue(value: unknown): SourceCellValue {
  if (value === null || value === undefined) {
    return { kind: 'empty' };
  }

  if (isFormulaValue(value)) {
    return {
      kind: 'formula',
      hasResult: value.result !== undefined && value.result !== null,
      result: value.result,
    };
  }

  if (isAggregateScalar(value)) {
    return { kind: 'value', value };
  }

  return { kind: 'unsupported', valueType: typeof value };
}

/** Converts a source value into a typed group value or raises a validation error. */
function toGroupValue(
  value: SourceCellValue | undefined,
  context: ValueContext,
): AggregateGroupValue {
  if (value === undefined || value.kind === 'empty') {
    return null;
  }

  if (value.kind === 'value') {
    return value.value;
  }

  if (value.kind === 'formula') {
    if (value.hasResult && isAggregateScalar(value.result)) {
      return value.result;
    }
    throwInvalidAggregationValue(context, 'Formula must have a usable cached result');
  }

  throwInvalidAggregationValue(context, `Unsupported value type '${value.valueType}'`);
}

/** Updates one metric accumulator using the current row value. */
function updateMetricAccumulator(
  accumulator: MetricAccumulator | undefined,
  metric: ResolvedMetric,
  value: SourceCellValue | undefined,
  context: ValueContext,
): void {
  if (accumulator === undefined) {
    return;
  }

  switch (metric.operation) {
    case 'count':
      if (isCountableValue(value, context)) {
        accumulator.count += 1;
      }
      return;
    case 'sum': {
      const numericValue = toNumericValue(value, context);
      if (numericValue === undefined) {
        return;
      }
      accumulator.sum += numericValue;
      return;
    }
    case 'average': {
      const numericValue = toNumericValue(value, context);
      if (numericValue === undefined) {
        return;
      }
      accumulator.sum += numericValue;
      accumulator.numericCount += 1;
      return;
    }
    case 'min': {
      const numericValue = toNumericValue(value, context);
      if (numericValue === undefined) {
        return;
      }
      accumulator.min =
        accumulator.min === null ? numericValue : Math.min(accumulator.min, numericValue);
      return;
    }
    case 'max': {
      const numericValue = toNumericValue(value, context);
      if (numericValue === undefined) {
        return;
      }
      accumulator.max =
        accumulator.max === null ? numericValue : Math.max(accumulator.max, numericValue);
      return;
    }
  }
}

/** Checks whether a source value is valid and non-empty for count. */
function isCountableValue(value: SourceCellValue | undefined, context: ValueContext): boolean {
  if (value === undefined || value.kind === 'empty') {
    return false;
  }

  if (value.kind === 'value') {
    return true;
  }

  if (value.kind === 'formula') {
    if (value.hasResult && isAggregateScalar(value.result)) {
      return true;
    }
    throwInvalidAggregationValue(context, 'Formula must have a usable non-empty cached result');
  }

  throwInvalidAggregationValue(context, `Unsupported value type '${value.valueType}'`);
}

/** Converts a source value to a numeric aggregation value when present. */
function toNumericValue(
  value: SourceCellValue | undefined,
  context: ValueContext,
): number | undefined {
  if (value === undefined || value.kind === 'empty') {
    return undefined;
  }

  if (value.kind === 'value' && typeof value.value === 'number' && Number.isFinite(value.value)) {
    return value.value;
  }

  if (
    value.kind === 'formula' &&
    value.hasResult &&
    typeof value.result === 'number' &&
    Number.isFinite(value.result)
  ) {
    return value.result;
  }

  if (value.kind === 'formula' && !value.hasResult) {
    throwInvalidAggregationValue(context, 'Formula must have a numeric cached result');
  }

  if (value.kind === 'unsupported') {
    throwInvalidAggregationValue(context, `Unsupported value type '${value.valueType}'`);
  }

  throwInvalidAggregationValue(context, 'Aggregation requires a number');
}

/** Finalizes one metric accumulator into its public numeric result. */
function finalizeMetricAccumulator(
  accumulator: MetricAccumulator | undefined,
  operation: AggregateOperation | undefined,
): AggregateMetricValue {
  if (accumulator === undefined || operation === undefined) {
    return null;
  }

  switch (operation) {
    case 'sum':
      return accumulator.sum;
    case 'count':
      return accumulator.count;
    case 'average':
      return accumulator.numericCount === 0 ? null : accumulator.sum / accumulator.numericCount;
    case 'min':
      return accumulator.min;
    case 'max':
      return accumulator.max;
  }
}

/** Creates an accumulator initialized for one group. */
function createGroupAccumulator(
  groupValues: readonly AggregateGroupValue[],
  metricCount: number,
): GroupAccumulator {
  return {
    groupValues,
    metrics: Array.from({ length: metricCount }, () => createMetricAccumulator()),
  };
}

/** Encodes group values with type tags so fields cannot collide. */
function createTypedGroupKey(values: readonly AggregateGroupValue[]): string {
  return JSON.stringify(values.map((value) => encodeTypedGroupValue(value)));
}

/** Encodes one group value with an explicit runtime type tag. */
function encodeTypedGroupValue(value: AggregateGroupValue): readonly [string, unknown] {
  if (value === null) {
    return ['null', null];
  }
  if (value instanceof Date) {
    return ['date', value.toISOString()];
  }
  return [typeof value, value];
}

/** Creates an empty accumulator shared by every supported operation. */
function createMetricAccumulator(): MetricAccumulator {
  return { sum: 0, count: 0, numericCount: 0, min: null, max: null };
}

/** Checks whether a worksheet row contains at least one actual value. */
function hasActualValueInRow(
  worksheet: Worksheet,
  rowNumber: number,
  startColumn: number,
  endColumn: number,
): boolean {
  for (let column = startColumn; column <= endColumn; column += 1) {
    const cell = worksheet.findCell(rowNumber, column);
    if (cell && hasActualCellValue(cell)) {
      return true;
    }
  }
  return false;
}

/** Creates location details for an aggregation value validation error. */
function createValueContext(
  sheetName: string,
  column: string,
  row: number,
  columnIndex: number,
  operation: AggregateOperation | 'groupBy',
): ValueContext {
  return {
    sheetName,
    column,
    address: formatCellAddress({ row, column: columnIndex }),
    operation,
  };
}

/** Throws a consistent invalid-aggregation-value error with cell details. */
function throwInvalidAggregationValue(context: ValueContext, reason: string): never {
  throw new ExcelCapabilityError(
    ExcelCapabilityErrorCode.INVALID_AGGREGATION_VALUE,
    `Invalid value for aggregate operation '${context.operation}' in column '${context.column}' at '${context.address}'`,
    { ...context, reason },
  );
}

/** Checks whether a value is a supported non-null aggregate scalar. */
function isAggregateScalar(value: unknown): value is AggregateScalar {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (value instanceof Date && !Number.isNaN(value.getTime()))
  );
}

/** Checks whether a value is an Excel formula or shared-formula object. */
function isFormulaValue(value: unknown): value is {
  readonly result?: unknown;
  readonly formula?: string;
  readonly sharedFormula?: string;
} {
  return (
    isRecord(value) &&
    (typeof value.formula === 'string' || typeof value.sharedFormula === 'string')
  );
}

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
