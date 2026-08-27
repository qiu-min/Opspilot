import type { ExcelInferredType } from './contracts.js';

import { hasNonEmptyCellValue } from '../shared/exceljs/cell-value.js';

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
  return hasNonEmptyCellValue(value);
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
