import { formatCellAddress } from '../shared/cell-reference.js';
import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../shared/errors.js';
import { isExcelCellScalar, type ParsedExcelCellValue } from '../shared/exceljs/cell-value.js';
import type { AggregateGroupValue, AggregateMetricValue, AggregateOperation } from './contracts.js';

export type SourceCellValue = ParsedExcelCellValue;

export interface ValueContext {
  readonly sheetName: string;
  readonly column: string;
  readonly address: string;
  readonly operation: AggregateOperation | 'groupBy';
}

export interface GroupAccumulator {
  readonly groupValues: readonly AggregateGroupValue[];
  readonly metrics: MetricAccumulator[];
}

export interface MetricAccumulator {
  sum: number;
  count: number;
  numericCount: number;
  min: number | null;
  max: number | null;
}

/** Creates an accumulator initialized for one group. */
export function createGroupAccumulator(
  groupValues: readonly AggregateGroupValue[],
  metricCount: number,
): GroupAccumulator {
  return {
    groupValues,
    metrics: Array.from({ length: metricCount }, () => createMetricAccumulator()),
  };
}

/** Encodes group values with type tags so fields cannot collide. */
export function createTypedGroupKey(values: readonly AggregateGroupValue[]): string {
  return JSON.stringify(values.map((value) => encodeTypedGroupValue(value)));
}

/** Converts a source value into a typed group value or raises a validation error. */
export function toGroupValue(
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
    if (value.hasResult && isExcelCellScalar(value.result)) {
      return value.result;
    }
    throwInvalidAggregationValue(context, 'Formula must have a usable cached result');
  }

  throwInvalidAggregationValue(context, `Unsupported value type '${value.valueType}'`);
}

/** Updates one metric accumulator using the current row value. */
export function updateMetricAccumulator(
  accumulator: MetricAccumulator | undefined,
  operation: AggregateOperation,
  value: SourceCellValue | undefined,
  context: ValueContext,
): void {
  if (accumulator === undefined) {
    return;
  }

  switch (operation) {
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

/** Finalizes one metric accumulator into its public numeric result. */
export function finalizeMetricAccumulator(
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

/** Creates location details for an aggregation value validation error. */
export function createValueContext(
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

/** Creates an empty accumulator shared by every supported operation. */
function createMetricAccumulator(): MetricAccumulator {
  return { sum: 0, count: 0, numericCount: 0, min: null, max: null };
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

/** Checks whether a source value is valid and non-empty for count. */
function isCountableValue(value: SourceCellValue | undefined, context: ValueContext): boolean {
  if (value === undefined || value.kind === 'empty') {
    return false;
  }

  if (value.kind === 'value') {
    return true;
  }

  if (value.kind === 'formula') {
    if (value.hasResult && isExcelCellScalar(value.result)) {
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

/** Throws a consistent invalid-aggregation-value error with cell details. */
function throwInvalidAggregationValue(context: ValueContext, reason: string): never {
  throw new ExcelCapabilityError(
    ExcelCapabilityErrorCode.INVALID_AGGREGATION_VALUE,
    `Invalid value for aggregate operation '${context.operation}' in column '${context.column}' at '${context.address}'`,
    { ...context, reason },
  );
}
