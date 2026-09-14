import type { Worksheet } from 'exceljs';

import { formatCellAddress, type CellRange } from '../cell-reference.js';
import { headerText } from './cell-value.js';
import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../errors.js';
import { detectHeaderRow } from './header-detection.js';
import { hasActualCellValue } from './used-range.js';
import { throwIfAborted } from './workbook-io.js';

export interface ExcelHeaderColumn {
  readonly name: string;
  readonly columnIndex: number;
}

export interface ExcelHeaderContext {
  readonly headerRow: number | null;
  readonly availableColumns: readonly string[];
  readonly matches: ReadonlyMap<string, readonly ExcelHeaderColumn[]>;
}

/** Detects and indexes exact header names using the shared header detector. */
export function findHeaderContext(
  worksheet: Worksheet,
  usedRange: CellRange | undefined,
  signal: AbortSignal | undefined,
  operation: string,
): ExcelHeaderContext {
  if (usedRange === undefined) {
    return { headerRow: null, availableColumns: [], matches: new Map() };
  }

  throwIfAborted(signal, operation);
  const detection = detectHeaderRow(worksheet, usedRange, signal);
  if (detection.headerRow === null) {
    return { headerRow: null, availableColumns: [], matches: new Map() };
  }

  const headerRow = detection.headerRow;
  const matches = new Map<string, ExcelHeaderColumn[]>();
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

/** Resolves one requested column against the exact indexed header names. */
export function resolveHeaderColumn(
  name: string,
  header: ExcelHeaderContext,
  sheetName: string,
): ExcelHeaderColumn {
  const headerRow = header.headerRow;
  if (headerRow === null) {
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
          formatCellAddress({ row: headerRow, column: match.columnIndex }),
        ),
      },
    );
  }

  return matches[0]!;
}
