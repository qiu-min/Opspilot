import type { Worksheet } from 'exceljs';

import { parseCellRange, type CellRange } from '../cell-reference.js';
import {
  createHeaderContext,
  findHeaderContext,
  type ExcelHeaderContext,
} from './header.js';
import { throwIfAborted } from './workbook-io.js';
import { findUsedRange } from './used-range.js';

export interface ExcelDatasetContext {
  readonly range: CellRange | undefined;
  readonly header: ExcelHeaderContext;
  readonly headerRow: number | null;
  readonly dataStartRow: number | null;
  readonly endRow: number | null;
  readonly startColumn: number | null;
  readonly endColumn: number | null;
}

/** Resolves the worksheet dataset using either an exact range or auto discovery. */
export function resolveDatasetContext(
  worksheet: Worksheet,
  explicitRange: string | undefined,
  signal: AbortSignal | undefined,
  operation: string,
): ExcelDatasetContext {
  throwIfAborted(signal, operation);

  const range =
    explicitRange === undefined ? findUsedRange(worksheet, 'values') : parseCellRange(explicitRange);
  if (range === undefined) {
    return createDatasetContext(undefined, {
      headerRow: null,
      availableColumns: [],
      matches: new Map(),
    });
  }

  const header =
    explicitRange === undefined
      ? findHeaderContext(worksheet, range, signal, operation)
      : createHeaderContext(worksheet, range, range.start.row);

  return createDatasetContext(range, header);
}

/** Builds the common row and column boundaries for either dataset mode. */
function createDatasetContext(
  range: CellRange | undefined,
  header: ExcelHeaderContext,
): ExcelDatasetContext {
  return {
    range,
    header,
    headerRow: header.headerRow,
    dataStartRow: header.headerRow === null ? null : header.headerRow + 1,
    endRow: range?.end.row ?? null,
    startColumn: range?.start.column ?? null,
    endColumn: range?.end.column ?? null,
  };
}
