import { ExcelCapabilityError, ExcelCapabilityErrorCode } from './errors.js';

export interface CellCoordinate {
  readonly row: number;
  readonly column: number;
}

export interface CellRange {
  readonly start: CellCoordinate;
  readonly end: CellCoordinate;
}

export function parseCellRange(reference: string): CellRange {
  const parts = reference.split(':');
  if (parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw invalidCellReference(reference);
  }

  const start = parseCell(reference, parts[0]);
  const end = parts.length === 2 ? parseCell(reference, parts[1]) : start;

  if (start.row > end.row || start.column > end.column) {
    throw invalidCellReference(reference, 'Range start must not be after its end');
  }

  return { start, end };
}

export function formatCellAddress(coordinate: CellCoordinate): string {
  return `${formatColumn(coordinate.column)}${coordinate.row}`;
}

export function formatCellRange(range: CellRange): string {
  return `${formatCellAddress(range.start)}:${formatCellAddress(range.end)}`;
}

function parseCell(reference: string, cell: string): CellCoordinate {
  const match = /^([A-Za-z]+)(\d+)$/.exec(cell);
  if (!match) {
    throw invalidCellReference(reference);
  }

  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row < 1) {
    throw invalidCellReference(reference);
  }

  let column = 0;
  for (const character of match[1].toUpperCase()) {
    column = column * 26 + character.charCodeAt(0) - 64;
    if (!Number.isSafeInteger(column)) {
      throw invalidCellReference(reference);
    }
  }

  if (column < 1) {
    throw invalidCellReference(reference);
  }

  return { row, column };
}

function formatColumn(column: number): string {
  let current = column;
  let result = '';

  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }

  return result;
}

function invalidCellReference(
  reference: string,
  reason = 'Invalid A1 cell reference',
): ExcelCapabilityError {
  return new ExcelCapabilityError(
    ExcelCapabilityErrorCode.INVALID_CELL_REFERENCE,
    `${reason}: '${reference}'`,
    { reference },
  );
}
