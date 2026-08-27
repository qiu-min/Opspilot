import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../shared/errors.js';
import {
  isExcelCellScalar,
  type ExcelCellScalarValue,
  type ParsedExcelCellValue,
} from '../shared/exceljs/cell-value.js';
import type {
  FilterCondition,
  FilterDataResult,
  FilterLogic,
  FilterOperator,
  FilterRowRange,
  FilterValue,
} from './contracts.js';

export interface FilterValueContext {
  readonly sheetName: string;
  readonly column: string;
  readonly address: string;
  readonly operator: FilterOperator;
}

export interface ResolvedFilterCondition {
  readonly condition: FilterCondition;
  readonly columnIndex: number;
}

export interface MatchedRangeAccumulator {
  readonly ranges: FilterRowRange[];
  matchedRowCount: number;
  currentRange: FilterRowRange | null;
}

/** Evaluates one typed filter condition against a parsed Excel cell value. */
export function matchesFilterCondition(
  value: ParsedExcelCellValue | undefined,
  condition: FilterCondition,
  context: FilterValueContext,
): boolean {
  const parsedValue = value ?? { kind: 'empty' as const };

  switch (condition.operator) {
    case 'isEmpty':
      return isEmptyValue(parsedValue, context);
    case 'isNotEmpty':
      return !isEmptyValue(parsedValue, context);
    case 'equals':
      return equalsValue(parsedValue, requireFilterValue(condition, context), context);
    case 'notEquals':
      return !equalsValue(parsedValue, requireFilterValue(condition, context), context);
    case 'greaterThan':
      return compareValue(
        parsedValue,
        requireFilterValue(condition, context),
        context,
        (left, right) => left > right,
      );
    case 'lessThan':
      return compareValue(
        parsedValue,
        requireFilterValue(condition, context),
        context,
        (left, right) => left < right,
      );
    case 'contains':
      return containsValue(parsedValue, requireFilterValue(condition, context), context);
  }
}

/** Combines condition results with all or any logic while short-circuiting evaluation. */
export function matchesConditions(
  values: ReadonlyMap<number, ParsedExcelCellValue>,
  conditions: readonly ResolvedFilterCondition[],
  logic: FilterLogic,
  contextFor: (condition: ResolvedFilterCondition) => FilterValueContext,
): boolean {
  if (logic === 'all') {
    for (const condition of conditions) {
      if (
        !matchesFilterCondition(
          values.get(condition.columnIndex),
          condition.condition,
          contextFor(condition),
        )
      ) {
        return false;
      }
    }
    return true;
  }

  for (const condition of conditions) {
    if (
      matchesFilterCondition(
        values.get(condition.columnIndex),
        condition.condition,
        contextFor(condition),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Creates the streaming accumulator used to compress matched row numbers into ranges. */
export function createMatchedRangeAccumulator(): MatchedRangeAccumulator {
  return { ranges: [], matchedRowCount: 0, currentRange: null };
}

/** Records one matched row without materializing a second row-number collection. */
export function recordMatchedRow(accumulator: MatchedRangeAccumulator, row: number): void {
  accumulator.matchedRowCount += 1;

  if (accumulator.currentRange === null) {
    accumulator.currentRange = { startRow: row, endRow: row };
    return;
  }

  if (accumulator.currentRange.endRow + 1 === row) {
    accumulator.currentRange = { ...accumulator.currentRange, endRow: row };
    return;
  }

  accumulator.ranges.push(accumulator.currentRange);
  accumulator.currentRange = { startRow: row, endRow: row };
}

/** Finalizes the current match range and returns a stable read-only range list. */
export function finalizeMatchedRanges(
  accumulator: MatchedRangeAccumulator,
): FilterDataResult['matchedRanges'] {
  if (accumulator.currentRange !== null) {
    accumulator.ranges.push(accumulator.currentRange);
    accumulator.currentRange = null;
  }
  return accumulator.ranges.slice();
}

/** Checks whether a parsed cell is semantically empty for filter predicates. */
function isEmptyValue(value: ParsedExcelCellValue, context: FilterValueContext): boolean {
  if (value.kind === 'empty') {
    return true;
  }

  if (value.kind === 'formula' && !value.hasResult) {
    throwInvalidFilterValue(
      context,
      'cached formula result',
      'formula',
      'Formula has no cached result',
    );
  }

  return false;
}

/** Compares a cell and condition value using strict types and Date timestamps. */
function equalsValue(
  actual: ParsedExcelCellValue,
  expected: FilterValue,
  context: FilterValueContext,
): boolean {
  if (actual.kind === 'empty') {
    return false;
  }

  const actualScalar = toComparableScalar(actual, context);
  if (actualScalar === undefined) {
    throwInvalidFilterValue(
      context,
      'string, number, boolean, or Date',
      describeParsedValue(actual),
      'Actual value cannot be compared for equality',
    );
  }
  return strictValueEquals(actualScalar, expected);
}

/** Compares numeric or Date values without string coercion. */
function compareValue(
  actual: ParsedExcelCellValue,
  expected: FilterValue,
  context: FilterValueContext,
  compare: (left: number, right: number) => boolean,
): boolean {
  if (!(typeof expected === 'number' || expected instanceof Date)) {
    throwInvalidFilterValue(
      context,
      'number or Date',
      describeValue(expected),
      'Comparison value must be numeric or Date',
    );
  }

  if (actual.kind === 'empty') {
    return false;
  }

  const actualScalar = toComparableScalar(actual, context);
  if (actualScalar === undefined) {
    throwInvalidFilterValue(
      context,
      describeValue(expected),
      describeValue(actual),
      'Actual value is not comparable',
    );
  }

  if (typeof expected === 'number' && typeof actualScalar === 'number') {
    return compare(actualScalar, expected);
  }

  if (expected instanceof Date && actualScalar instanceof Date) {
    return compare(actualScalar.getTime(), expected.getTime());
  }

  throwInvalidFilterValue(
    context,
    describeValue(expected),
    describeValue(actualScalar),
    'Actual value has an incompatible type',
  );
}

/** Checks a case-sensitive string containment condition. */
function containsValue(
  actual: ParsedExcelCellValue,
  expected: FilterValue,
  context: FilterValueContext,
): boolean {
  if (typeof expected !== 'string') {
    throwInvalidFilterValue(
      context,
      'string',
      describeValue(expected),
      'Contains value must be a string',
    );
  }

  if (actual.kind === 'empty') {
    return false;
  }

  const actualScalar = toComparableScalar(actual, context);
  if (actualScalar === undefined) {
    throwInvalidFilterValue(
      context,
      'string',
      describeValue(actual),
      'Actual value is not searchable text',
    );
  }
  if (typeof actualScalar !== 'string') {
    throwInvalidFilterValue(
      context,
      'string',
      describeValue(actualScalar),
      'Actual value is not searchable text',
    );
  }
  return actualScalar.includes(expected);
}

/** Requires the condition value needed by value-based operators. */
function requireFilterValue(condition: FilterCondition, context: FilterValueContext): FilterValue {
  if (condition.value === undefined) {
    throwInvalidFilterValue(context, 'filter value', 'missing', 'Operator requires a value');
  }
  return condition.value;
}

/** Converts a parsed cell to a scalar while preserving unsupported-value behavior. */
function toComparableScalar(
  value: ParsedExcelCellValue,
  context: FilterValueContext,
): ExcelCellScalarValue | undefined {
  if (value.kind === 'value') {
    return value.value;
  }

  if (value.kind === 'formula') {
    if (!value.hasResult) {
      throwInvalidFilterValue(
        context,
        'cached formula result',
        'formula',
        'Formula has no cached result',
      );
    }
    if (isExcelCellScalar(value.result)) {
      return value.result;
    }
    throwInvalidFilterValue(
      context,
      'string, number, boolean, or Date',
      'formula result',
      'Formula cached result is unsupported',
    );
  }

  if (value.kind === 'unsupported') {
    return undefined;
  }

  return undefined;
}

/** Compares two supported scalar values without coercing their runtime types. */
function strictValueEquals(left: ExcelCellScalarValue, right: FilterValue): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  return typeof left === typeof right && left === right;
}

/** Describes a runtime value for filter validation details. */
function describeValue(value: unknown): string {
  if (value instanceof Date) {
    return 'Date';
  }
  if (value === null) {
    return 'null';
  }
  return typeof value;
}

function describeParsedValue(value: ParsedExcelCellValue): string {
  switch (value.kind) {
    case 'empty':
      return 'empty';

    case 'value':
      return describeValue(value.value);

    case 'formula':
      return value.hasResult
        ? `formula result (${describeValue(value.result)})`
        : 'formula without cached result';

    case 'unsupported':
      return value.valueType;
  }
}

/** Throws a consistent invalid-filter-value error with cell details. */
function throwInvalidFilterValue(
  context: FilterValueContext,
  expectedType: string,
  actualType: string,
  reason: string,
): never {
  throw new ExcelCapabilityError(
    ExcelCapabilityErrorCode.INVALID_FILTER_VALUE,
    `Invalid value for filter operator '${context.operator}' in column '${context.column}' at '${context.address}'`,
    { ...context, expectedType, actualType, reason },
  );
}
