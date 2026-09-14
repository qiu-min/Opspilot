import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../errors.js';
import {
  isExcelCellScalar,
  type ExcelCellScalarValue,
  type ParsedExcelCellValue,
} from '../exceljs/cell-value.js';
import type {
  ExcelPredicate,
  ExcelPredicateLogic,
  ExcelPredicateOperator,
  ExcelPredicateValue,
} from './predicate-contracts.js';

export interface PredicateValueContext {
  readonly sheetName: string;
  readonly column: string;
  readonly address: string;
  readonly operator: ExcelPredicateOperator;
}

export interface ResolvedExcelPredicate {
  readonly predicate: ExcelPredicate;
  readonly columnIndex: number;
}

/** Evaluates one shared predicate against a parsed Excel cell value. */
export function evaluatePredicate(
  value: ParsedExcelCellValue | undefined,
  predicate: ExcelPredicate,
  context: PredicateValueContext,
): boolean {
  const parsedValue = value ?? { kind: 'empty' as const };

  switch (predicate.operator) {
    case 'isEmpty':
      return isEmptyValue(parsedValue, context);
    case 'isNotEmpty':
      return !isEmptyValue(parsedValue, context);
    case 'equals':
      return equalsValue(parsedValue, requirePredicateValue(predicate, context), context);
    case 'notEquals':
      return !equalsValue(parsedValue, requirePredicateValue(predicate, context), context);
    case 'greaterThan':
      return compareValue(
        parsedValue,
        requirePredicateValue(predicate, context),
        context,
        (left, right) => left > right,
      );
    case 'lessThan':
      return compareValue(
        parsedValue,
        requirePredicateValue(predicate, context),
        context,
        (left, right) => left < right,
      );
    case 'contains':
      return containsValue(parsedValue, requirePredicateValue(predicate, context), context);
  }
}

/** Combines resolved predicates with all or any logic while short-circuiting evaluation. */
export function evaluatePredicates(
  values: ReadonlyMap<number, ParsedExcelCellValue>,
  predicates: readonly ResolvedExcelPredicate[],
  logic: ExcelPredicateLogic,
  contextFor: (predicate: ResolvedExcelPredicate) => PredicateValueContext,
): boolean {
  if (logic === 'all') {
    for (const predicate of predicates) {
      if (
        !evaluatePredicate(
          values.get(predicate.columnIndex),
          predicate.predicate,
          contextFor(predicate),
        )
      ) {
        return false;
      }
    }
    return true;
  }

  for (const predicate of predicates) {
    if (
      evaluatePredicate(
        values.get(predicate.columnIndex),
        predicate.predicate,
        contextFor(predicate),
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Checks whether a parsed cell is semantically empty for predicates. */
function isEmptyValue(value: ParsedExcelCellValue, context: PredicateValueContext): boolean {
  if (value.kind === 'empty') {
    return true;
  }

  if (value.kind === 'formula' && !value.hasResult) {
    throwInvalidPredicateValue(
      context,
      'cached formula result',
      'formula',
      'Formula has no cached result',
    );
  }

  return false;
}

/** Compares a cell and predicate value using strict types and Date timestamps. */
function equalsValue(
  actual: ParsedExcelCellValue,
  expected: ExcelPredicateValue,
  context: PredicateValueContext,
): boolean {
  if (actual.kind === 'empty') {
    return false;
  }

  const actualScalar = toComparableScalar(actual, context);
  if (actualScalar === undefined) {
    throwInvalidPredicateValue(
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
  expected: ExcelPredicateValue,
  context: PredicateValueContext,
  compare: (left: number, right: number) => boolean,
): boolean {
  if (!(typeof expected === 'number' || expected instanceof Date)) {
    throwInvalidPredicateValue(
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
    throwInvalidPredicateValue(
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

  throwInvalidPredicateValue(
    context,
    describeValue(expected),
    describeValue(actualScalar),
    'Actual value has an incompatible type',
  );
}

/** Checks a case-sensitive string containment predicate. */
function containsValue(
  actual: ParsedExcelCellValue,
  expected: ExcelPredicateValue,
  context: PredicateValueContext,
): boolean {
  if (typeof expected !== 'string') {
    throwInvalidPredicateValue(
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
    throwInvalidPredicateValue(
      context,
      'string',
      describeParsedValue(actual),
      'Actual value is not searchable text',
    );
  }
  if (typeof actualScalar !== 'string') {
    throwInvalidPredicateValue(
      context,
      'string',
      describeValue(actualScalar),
      'Actual value is not searchable text',
    );
  }
  return actualScalar.includes(expected);
}

/** Requires the predicate value needed by value-based operators. */
function requirePredicateValue(
  predicate: ExcelPredicate,
  context: PredicateValueContext,
): ExcelPredicateValue {
  if (predicate.value === undefined) {
    throwInvalidPredicateValue(context, 'predicate value', 'missing', 'Operator requires a value');
  }
  return predicate.value;
}

/** Converts a parsed cell to a scalar while preserving unsupported-value behavior. */
function toComparableScalar(
  value: ParsedExcelCellValue,
  context: PredicateValueContext,
): ExcelCellScalarValue | undefined {
  if (value.kind === 'value') {
    return value.value;
  }

  if (value.kind === 'formula') {
    if (!value.hasResult) {
      throwInvalidPredicateValue(
        context,
        'cached formula result',
        'formula',
        'Formula has no cached result',
      );
    }
    if (isExcelCellScalar(value.result)) {
      return value.result;
    }
    throwInvalidPredicateValue(
      context,
      'string, number, boolean, or Date',
      'formula result',
      'Formula cached result is unsupported',
    );
  }

  return undefined;
}

/** Compares two supported scalar values without coercing their runtime types. */
function strictValueEquals(left: ExcelCellScalarValue, right: ExcelPredicateValue): boolean {
  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  return typeof left === typeof right && left === right;
}

/** Describes a runtime value for predicate validation details. */
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

/** Throws a consistent invalid-predicate error with cell details. */
function throwInvalidPredicateValue(
  context: PredicateValueContext,
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
