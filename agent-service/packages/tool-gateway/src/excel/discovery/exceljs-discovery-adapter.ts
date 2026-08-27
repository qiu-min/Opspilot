import type { Worksheet } from 'exceljs';

import { formatCellRange, formatColumnLetter, type CellRange } from '../shared/cell-reference.js';
import {
  executeExcelOperation,
  getActiveWorksheet,
  openWorkbook,
  requireWorksheet,
  throwIfAborted,
} from '../shared/exceljs/workbook-io.js';
import { headerText } from '../shared/exceljs/cell-value.js';
import { findUsedRange, hasActualValueInRow } from '../shared/exceljs/used-range.js';
import type { ExcelDiscoveryConnector } from './connector.js';
import type {
  GetSheetProfileInput,
  GetSheetProfileResult,
  GetWorkbookInfoInput,
  GetWorkbookInfoResult,
  SheetColumnProfile,
  WorkbookSheetSummary,
} from './contracts.js';
import { getSheetProfileInputSchema, getWorkbookInfoInputSchema } from './schemas.js';
import { inferColumnType, isValidSample } from './type-inference.js';

export class ExcelJsDiscoveryAdapter implements ExcelDiscoveryConnector {
  /** Inspects workbook structure and returns sheet summaries. */
  async getWorkbookInfo(
    input: GetWorkbookInfoInput,
    signal?: AbortSignal,
  ): Promise<GetWorkbookInfoResult> {
    const validated = getWorkbookInfoInputSchema.parse(input);

    return executeExcelOperation('getWorkbookInfo', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const sheets: WorkbookSheetSummary[] = workbook.worksheets.map((worksheet, index) => {
        throwIfAborted(signal, 'getWorkbookInfo');
        return summarizeWorksheet(worksheet, index + 1);
      });
      const activeWorksheet = getActiveWorksheet(workbook);

      return {
        sheetCount: sheets.length,
        ...(activeWorksheet ? { activeSheetName: activeWorksheet.name } : {}),
        sheets,
      };
    });
  }

  /** Profiles one worksheet's used range, headers, and sampled column types. */
  async getSheetProfile(
    input: GetSheetProfileInput,
    signal?: AbortSignal,
  ): Promise<GetSheetProfileResult> {
    const validated = getSheetProfileInputSchema.parse(input);

    return executeExcelOperation('getSheetProfile', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = requireWorksheet(workbook, validated.sheetName);
      const usedRange = findUsedRange(worksheet, 'values');

      if (!usedRange) {
        return emptySheetProfile(worksheet.name);
      }

      const headerRow = findHeaderRow(worksheet, usedRange, signal);
      const sampleValues = createSampleBuckets(
        usedRange,
        headerRow,
        worksheet,
        validated.sampleSize,
        signal,
      );
      const columns = createColumnProfiles(worksheet, usedRange, headerRow, sampleValues);

      return {
        sheetName: worksheet.name,
        usedRange: formatCellRange(usedRange),
        rowCount: usedRange.end.row - usedRange.start.row + 1,
        columnCount: usedRange.end.column - usedRange.start.column + 1,
        headerRow,
        sampledRowCount: sampleValues.sampledRowCount,
        columns,
      };
    });
  }
}

/** Summarizes a worksheet using its value-based used range. */
function summarizeWorksheet(worksheet: Worksheet, index: number): WorkbookSheetSummary {
  const usedRange = findUsedRange(worksheet, 'values');

  return {
    name: worksheet.name,
    index,
    state: worksheet.state,
    usedRange: usedRange ? formatCellRange(usedRange) : null,
    rowCount: usedRange ? usedRange.end.row - usedRange.start.row + 1 : 0,
    columnCount: usedRange ? usedRange.end.column - usedRange.start.column + 1 : 0,
  };
}

/** Builds an empty profile for a worksheet with no values. */
function emptySheetProfile(sheetName: string): GetSheetProfileResult {
  return {
    sheetName,
    usedRange: null,
    rowCount: 0,
    columnCount: 0,
    headerRow: null,
    sampledRowCount: 0,
    columns: [],
  };
}

/** Finds the first row containing an actual value. */
function findHeaderRow(
  worksheet: Worksheet,
  usedRange: CellRange,
  signal: AbortSignal | undefined,
): number | null {
  for (let row = usedRange.start.row; row <= usedRange.end.row; row += 1) {
    throwIfAborted(signal, 'getSheetProfile');
    if (hasActualValueInRow(worksheet, row, usedRange.start.column, usedRange.end.column)) {
      return row;
    }
  }

  return null;
}

interface SampleBuckets {
  readonly values: readonly unknown[][];
  readonly sampledRowCount: number;
}

/** Collects per-column samples after the detected header row. */
function createSampleBuckets(
  usedRange: CellRange,
  headerRow: number | null,
  worksheet: Worksheet,
  sampleSize: number,
  signal: AbortSignal | undefined,
): SampleBuckets {
  const values: unknown[][] = [];
  const columnCount = usedRange.end.column - usedRange.start.column + 1;
  for (let index = 0; index < columnCount; index += 1) {
    values.push([]);
  }

  if (headerRow === null) {
    return { values, sampledRowCount: 0 };
  }

  let sampledRowCount = 0;
  for (let row = headerRow + 1; row <= usedRange.end.row; row += 1) {
    throwIfAborted(signal, 'getSheetProfile');
    let sampledFromRow = false;

    for (let column = usedRange.start.column; column <= usedRange.end.column; column += 1) {
      const bucket = values[column - usedRange.start.column];
      const cellValue = worksheet.findCell(row, column)?.value;
      if (bucket === undefined || !isValidSample(cellValue) || bucket.length >= sampleSize) {
        continue;
      }

      bucket.push(cellValue);
      sampledFromRow = true;
    }

    if (sampledFromRow) {
      sampledRowCount += 1;
    }

    if (values.every((bucket) => bucket.length >= sampleSize)) {
      break;
    }
  }

  return { values, sampledRowCount };
}

/** Builds public column profiles from headers and samples. */
function createColumnProfiles(
  worksheet: Worksheet,
  usedRange: CellRange,
  headerRow: number | null,
  sampleBuckets: SampleBuckets,
): SheetColumnProfile[] {
  const columns: SheetColumnProfile[] = [];

  for (let column = usedRange.start.column; column <= usedRange.end.column; column += 1) {
    const value = headerRow === null ? null : worksheet.findCell(headerRow, column)?.value;
    columns.push({
      index: column,
      letter: formatColumnLetter(column),
      header: headerText(value),
      inferredType: inferColumnType(sampleBuckets.values[column - usedRange.start.column] ?? []),
    });
  }

  return columns;
}

/** Checks whether a row contains at least one actual value in the range. */
