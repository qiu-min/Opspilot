import type { ExcelInferredType } from './contracts.js';

/** Infers one aggregate type from the valid values in a column. */
export function inferColumnType(values: readonly unknown[]): ExcelInferredType {
  const types = new Set<ExcelInferredType>();

  for (const value of values) {
    if (!isValidSample(value)) {
      continue;
    }

    types.add(inferValueType(value));
  }

  if (types.size === 0) {
    return 'empty';
  }

  if (types.size === 1) {
    return types.values().next().value ?? 'empty';
  }

  return 'mixed';
}

/** Checks whether a value is suitable for sampling or type inference. */
export function isValidSample(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }

  if (typeof value === 'string') {
    return value.length > 0;
  }

  if (isRecord(value) && typeof value.text === 'string') {
    return value.text.length > 0;
  }

  if (isRecord(value) && Array.isArray(value.richText)) {
    return value.richText.some(
      (run) => isRecord(run) && typeof run.text === 'string' && run.text.length > 0,
    );
  }

  return true;
}

/** Converts a sampled value into displayable header text. */
export function headerText(value: unknown): string | null {
  if (!isValidSample(value)) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (isRecord(value) && typeof value.text === 'string') {
    return value.text;
  }

  if (isRecord(value) && Array.isArray(value.richText)) {
    const text = value.richText
      .filter(isRecord)
      .map((run) => (typeof run.text === 'string' ? run.text : ''))
      .join('');
    return text.length === 0 ? null : text;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (isRecord(value) && typeof value.formula === 'string') {
    return value.formula;
  }

  if (isRecord(value) && typeof value.sharedFormula === 'string') {
    return value.sharedFormula;
  }

  if (isRecord(value) && typeof value.error === 'string') {
    return value.error;
  }

  return String(value);
}

/** Infers the type of one Excel value. */
function inferValueType(value: unknown): ExcelInferredType {
  if (
    isRecord(value) &&
    (typeof value.formula === 'string' || typeof value.sharedFormula === 'string')
  ) {
    return 'formula';
  }

  if (isRecord(value) && isExcelError(value.error)) {
    return 'error';
  }

  if (isRecord(value) && (typeof value.text === 'string' || Array.isArray(value.richText))) {
    return 'string';
  }

  if (value instanceof Date) {
    return 'date';
  }

  if (typeof value === 'string') {
    return 'string';
  }

  if (typeof value === 'number') {
    return 'number';
  }

  if (typeof value === 'boolean') {
    return 'boolean';
  }

  return 'mixed';
}

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Checks whether a value is an Excel error code. */
function isExcelError(value: unknown): boolean {
  return (
    value === '#N/A' ||
    value === '#REF!' ||
    value === '#NAME?' ||
    value === '#DIV/0!' ||
    value === '#NULL!' ||
    value === '#VALUE!' ||
    value === '#NUM!'
  );
}
