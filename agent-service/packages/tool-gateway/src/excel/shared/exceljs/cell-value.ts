/** Checks whether an ExcelJS cell value contains a non-empty value. */
export function hasNonEmptyCellValue(value: unknown): boolean {
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

/** Converts an ExcelJS cell value into text suitable for exact header matching. */
export function headerText(value: unknown): string | null {
  if (!hasNonEmptyCellValue(value)) {
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

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
