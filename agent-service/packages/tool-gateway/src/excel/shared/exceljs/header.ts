import type { Worksheet } from 'exceljs';

import { formatCellAddress, type CellRange } from '../cell-reference.js';
import { headerText } from './cell-value.js';
import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../errors.js';
import { throwIfAborted } from './workbook-io.js';
import { hasActualCellValue, hasActualValueInRow } from './used-range.js';

export interface ExcelHeaderColumn {
  readonly name: string;
  readonly columnIndex: number;
}

export interface ExcelHeaderContext {
  readonly headerRow: number;
  readonly availableColumns: readonly string[];
  readonly matches: ReadonlyMap<string, readonly ExcelHeaderColumn[]>;
}

/** Finds the first value row and indexes its exact Excel header names. */
export function findHeaderContext(
  worksheet: Worksheet,
  usedRange: CellRange | undefined,
  signal: AbortSignal | undefined,
  operation: string,
): ExcelHeaderContext {
  if (usedRange === undefined) {
    return { headerRow: 0, availableColumns: [], matches: new Map() };
  }

  let headerRow: number | undefined;
  for (let row = usedRange.start.row; row <= usedRange.end.row; row += 1) {
    throwIfAborted(signal, operation);
    if (hasActualValueInRow(worksheet, row, usedRange.start.column, usedRange.end.column)) {
      headerRow = row;
      break;
    }
  }

  if (headerRow === undefined) {
    return { headerRow: usedRange.start.row, availableColumns: [], matches: new Map() };
  }

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
