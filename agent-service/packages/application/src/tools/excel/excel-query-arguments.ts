import type {
  ExcelPredicate,
  ExcelPredicateLogic,
  ExcelPredicateOperator,
} from '@opspilot/tool-gateway';

const EXCEL_PREDICATE_OPERATORS = [
  'equals',
  'notEquals',
  'greaterThan',
  'lessThan',
  'contains',
  'isEmpty',
  'isNotEmpty',
] as const satisfies readonly ExcelPredicateOperator[];

const VALUE_REQUIRED_OPERATORS = new Set<ExcelPredicateOperator>([
  'equals',
  'notEquals',
  'greaterThan',
  'lessThan',
  'contains',
]);

/** The predicate value types supported by the model-facing Excel tools. */
export type ModelExcelPredicate = Omit<ExcelPredicate, 'value'> & {
  readonly value?: string | number | boolean;
};

/** Narrows an optional model-facing resource selector. */
export function narrowOptionalExcelResourceAlias(
  value: unknown,
  toolName: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${toolName} resource must be a non-empty string when provided.`);
  }
  return value;
}

/** Narrows a required non-empty worksheet name. */
export function narrowRequiredExcelString(value: unknown, name: string, toolName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${toolName} requires a non-empty ${name} string.`);
  }
  return value;
}

/** Narrows an optional non-empty Excel argument. */
export function narrowOptionalExcelString(
  value: unknown,
  name: string,
  toolName: string,
): string | undefined {
  if (value === undefined) return undefined;
  return narrowRequiredExcelString(value, name, toolName);
}

/** Validates and narrows the optional all/any predicate logic. */
export function narrowExcelPredicateLogic(
  value: unknown,
  toolName: string,
): ExcelPredicateLogic | undefined {
  if (value === undefined) return undefined;
  if (value !== 'all' && value !== 'any') {
    throw new TypeError(`${toolName} logic must be 'all' or 'any'.`);
  }
  return value;
}

/** Validates and narrows model predicates without accepting JavaScript Date objects. */
export function narrowExcelPredicates(value: unknown, toolName: string): ModelExcelPredicate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${toolName} conditions must contain at least one predicate.`);
  }

  const predicates: ModelExcelPredicate[] = [];
  for (const candidate of value as readonly unknown[]) {
    if (!isRecord(candidate)) {
      throw new TypeError(`${toolName} conditions must contain predicate objects.`);
    }

    const column = narrowRequiredExcelString(candidate.column, 'column', toolName);
    const operator = narrowExcelPredicateOperator(candidate.operator, toolName);
    const hasValue = Object.prototype.hasOwnProperty.call(candidate, 'value');
    const predicateValue = candidate.value;

    if (VALUE_REQUIRED_OPERATORS.has(operator)) {
      if (!isModelPredicateValue(predicateValue)) {
        throw new TypeError(
          `${toolName} ${operator} predicates require a string, finite number, or boolean value.`,
        );
      }
    } else if (hasValue) {
      throw new TypeError(`${toolName} ${operator} predicates must not include a value.`);
    }

    predicates.push({
      column,
      operator,
      ...(VALUE_REQUIRED_OPERATORS.has(operator)
        ? { value: predicateValue as string | number | boolean }
        : {}),
    });
  }

  return predicates;
}

/** Narrows an operator to the shared Tool Gateway predicate vocabulary. */
function narrowExcelPredicateOperator(value: unknown, toolName: string): ExcelPredicateOperator {
  if (
    typeof value !== 'string' ||
    !EXCEL_PREDICATE_OPERATORS.some((operator) => operator === value)
  ) {
    throw new TypeError(`${toolName} predicate operator is invalid.`);
  }
  return value as ExcelPredicateOperator;
}

/** Checks the primitive predicate values accepted by the model-facing tools. */
function isModelPredicateValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Checks that a JSON value is a non-array object before reading named properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
