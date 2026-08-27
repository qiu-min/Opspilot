import { type CellValue, type DataValidation, type Worksheet } from 'exceljs';

import { ExcelCapabilityError, ExcelCapabilityErrorCode } from '../shared/errors.js';
import {
  formatCellAddress,
  formatCellRange,
  parseCellRange,
  type CellCoordinate,
  type CellRange,
} from '../shared/cell-reference.js';
import {
  readRangeInputSchema,
  readRangeWithMetadataInputSchema,
  writeDataInputSchema,
} from './schemas.js';
import type { ExcelDataConnector } from './connector.js';
import type {
  ExcelCellValidation,
  ExcelCellValue,
  ExcelErrorValue,
  ExcelFormulaResult,
  ExcelMetadataCell,
  ExcelScalarValue,
  ExcelValidationFormula,
  ReadRangeInput,
  ReadRangeResult,
  ReadRangeWithMetadataInput,
  ReadRangeWithMetadataResult,
  WriteDataInput,
  WriteDataResult,
} from './contracts.js';
import {
  executeExcelOperation,
  getActiveWorksheet,
  openWorkbook,
  requireWorksheet,
  saveWorkbook,
} from '../shared/exceljs/workbook-io.js';
import { findUsedRange, type UsedRangeMode } from '../shared/exceljs/used-range.js';

export class ExcelJsDataAdapter implements ExcelDataConnector {
  /** Reads a value-oriented range from an Excel worksheet. */
  async readRange(input: ReadRangeInput, signal?: AbortSignal): Promise<ReadRangeResult> {
    const validated = readRangeInputSchema.parse(input);

    return executeExcelOperation('readRange', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = requireWorksheet(workbook, validated.sheetName);
      const requested = parseRequestedRange(validated.startCell, validated.endCell);
      const resolved = resolveReadRange(worksheet, requested, 'values', false);

      if (!resolved.hasData) {
        return {
          sheetName: worksheet.name,
          range: formatCellRange(resolved.range),
          values: [],
        };
      }

      const values: ExcelCellValue[][] = [];
      for (let row = resolved.range.start.row; row <= resolved.range.end.row; row += 1) {
        const rowValues: ExcelCellValue[] = [];
        for (
          let column = resolved.range.start.column;
          column <= resolved.range.end.column;
          column += 1
        ) {
          rowValues.push(normalizeCellValue(worksheet.getCell(row, column).value));
        }

        if (rowValues.some((value) => value !== null)) {
          values.push(rowValues);
        }
      }

      return {
        sheetName: worksheet.name,
        range: formatCellRange(resolved.range),
        values,
      };
    });
  }

  /** Writes a rectangular data set to an Excel worksheet. */
  async writeData(input: WriteDataInput, signal?: AbortSignal): Promise<WriteDataResult> {
    const validated = parseWriteDataInput(input);

    return executeExcelOperation('writeData', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = validated.sheetName
        ? (workbook.getWorksheet(validated.sheetName) ?? workbook.addWorksheet(validated.sheetName))
        : (getActiveWorksheet(workbook) ?? noActiveWorksheet());
      const start = parseSingleCell(validated.startCell);

      for (let rowOffset = 0; rowOffset < validated.data.length; rowOffset += 1) {
        const row = validated.data[rowOffset];
        for (let columnOffset = 0; columnOffset < row.length; columnOffset += 1) {
          worksheet.getCell(start.row + rowOffset, start.column + columnOffset).value =
            toExcelJsCellValue(row[columnOffset]);
        }
      }

      await saveWorkbook(workbook, validated.filePath, signal);

      const end: CellCoordinate = {
        row: start.row + validated.data.length - 1,
        column: start.column + Math.max(...validated.data.map((row) => row.length)) - 1,
      };
      const range = formatCellRange({ start, end });

      return {
        sheetName: worksheet.name,
        range,
        message: `Data written to ${worksheet.name}`,
      };
    });
  }

  /** Reads worksheet cells with optional validation metadata. */
  async readRangeWithMetadata(
    input: ReadRangeWithMetadataInput,
    signal?: AbortSignal,
  ): Promise<ReadRangeWithMetadataResult> {
    const validated = readRangeWithMetadataInputSchema.parse(input);

    return executeExcelOperation('readRangeWithMetadata', validated.filePath, signal, async () => {
      const workbook = await openWorkbook(validated.filePath, signal);
      const worksheet = requireWorksheet(workbook, validated.sheetName);
      const requested = parseRequestedRange(validated.startCell, validated.endCell);
      const usedRangeMode: UsedRangeMode = validated.includeValidation
        ? 'valuesAndMetadata'
        : 'values';
      const resolved = resolveReadRange(worksheet, requested, usedRangeMode, true);

      if (!resolved.hasData) {
        return {
          sheetName: worksheet.name,
          range: formatCellRange(resolved.range),
          cells: [],
        };
      }

      const cells: ExcelMetadataCell[] = [];
      for (let row = resolved.range.start.row; row <= resolved.range.end.row; row += 1) {
        for (
          let column = resolved.range.start.column;
          column <= resolved.range.end.column;
          column += 1
        ) {
          const cell = worksheet.getCell(row, column);
          const metadataCell: ExcelMetadataCell = {
            address: formatCellAddress({ row, column }),
            row,
            column,
            value: normalizeCellValue(cell.value),
            ...(validated.includeValidation
              ? { validation: mapDataValidation(cell.dataValidation) }
              : {}),
          };
          cells.push(metadataCell);
        }
      }

      return {
        sheetName: worksheet.name,
        range: formatCellRange(resolved.range),
        cells,
      };
    });
  }
}

/** Throws when no worksheet is available for an active-sheet write. */
function noActiveWorksheet(): never {
  throw new ExcelCapabilityError(
    ExcelCapabilityErrorCode.NO_ACTIVE_WORKSHEET,
    'No active worksheet found in workbook',
  );
}

interface RequestedRange {
  readonly range: CellRange;
  readonly isExplicit: boolean;
}

interface ResolvedReadRange {
  readonly range: CellRange;
  readonly hasData: boolean;
}

/** Validates and combines the requested start and end cells. */
function parseRequestedRange(startCell: string, endCell: string | undefined): RequestedRange {
  const startRange = parseCellRange(startCell);
  if (endCell === undefined) {
    return { range: startRange, isExplicit: !isSingleCell(startRange) };
  }

  if (!isSingleCell(startRange)) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.INVALID_CELL_REFERENCE,
      `The start cell must be a single cell when endCell is provided: '${startCell}'`,
      { startCell, endCell },
    );
  }

  const endRange = parseCellRange(endCell);
  if (!isSingleCell(endRange)) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.INVALID_CELL_REFERENCE,
      `The end cell must be a single cell: '${endCell}'`,
      { endCell },
    );
  }

  if (startRange.start.row > endRange.end.row || startRange.start.column > endRange.end.column) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.INVALID_CELL_REFERENCE,
      `Range start must not be after its end: '${startCell}:${endCell}'`,
      { startCell, endCell },
    );
  }

  return {
    range: { start: startRange.start, end: endRange.end },
    isExplicit: true,
  };
}

/** Parses a reference that must identify one cell. */
function parseSingleCell(reference: string): CellCoordinate {
  const range = parseCellRange(reference);
  if (!isSingleCell(range)) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.INVALID_CELL_REFERENCE,
      `Expected a single cell reference: '${reference}'`,
      { reference },
    );
  }

  return range.start;
}

/** Resolves the effective read range while preserving explicit-range behavior. */
function resolveReadRange(
  worksheet: Worksheet,
  requested: RequestedRange,
  usedRangeMode: UsedRangeMode,
  metadataMode: boolean,
): ResolvedReadRange {
  const usedRange = findUsedRange(worksheet, usedRangeMode);
  const rangeForExplicitRequest = requested.isExplicit
    ? findUsedRange(worksheet, 'valuesAndMetadata')
    : usedRange;

  if (
    requested.range.start.row > (rangeForExplicitRequest?.end.row ?? 0) ||
    requested.range.start.column > (rangeForExplicitRequest?.end.column ?? 0)
  ) {
    return { range: requested.range, hasData: false };
  }

  if (requested.isExplicit) {
    return { range: requested.range, hasData: Boolean(rangeForExplicitRequest) };
  }

  if (!usedRange) {
    return { range: requested.range, hasData: false };
  }

  const startsAtA1 = requested.range.start.row === 1 && requested.range.start.column === 1;
  if (metadataMode && !startsAtA1) {
    return {
      range: { start: requested.range.start, end: usedRange.end },
      hasData: true,
    };
  }

  return { range: usedRange, hasData: true };
}

/** Converts an ExcelJS cell value into the public Excel value model. */
function normalizeCellValue(value: CellValue): ExcelCellValue {
  if (value === null || value === undefined) {
    return null;
  }

  if (isScalarValue(value)) {
    return value;
  }

  if (!isRecord(value)) {
    throw new Error('Unsupported Excel cell value');
  }

  if (typeof value.formula === 'string') {
    return {
      formula: value.formula,
      ...(value.result !== undefined ? { result: normalizeFormulaResult(value.result) } : {}),
      ...(typeof value.date1904 === 'boolean' ? { date1904: value.date1904 } : {}),
    };
  }

  if (typeof value.sharedFormula === 'string') {
    return {
      sharedFormula: value.sharedFormula,
      ...(typeof value.formula === 'string' ? { formula: value.formula } : {}),
      ...(value.result !== undefined ? { result: normalizeFormulaResult(value.result) } : {}),
      ...(typeof value.date1904 === 'boolean' ? { date1904: value.date1904 } : {}),
    };
  }

  if (typeof value.hyperlink === 'string' && typeof value.text === 'string') {
    return {
      text: value.text,
      hyperlink: value.hyperlink,
      ...(typeof value.tooltip === 'string' ? { tooltip: value.tooltip } : {}),
    };
  }

  if (Array.isArray(value.richText)) {
    return {
      richText: value.richText.map((run) => {
        if (!isRecord(run) || typeof run.text !== 'string') {
          throw new Error('Unsupported Excel rich text value');
        }
        return { text: run.text };
      }),
    };
  }

  if (isExcelErrorValue(value.error)) {
    return { error: value.error };
  }

  throw new Error('Unsupported Excel cell value');
}

/** Converts a formula result into the public formula-result model. */
function normalizeFormulaResult(value: unknown): ExcelFormulaResult {
  if (isScalarValue(value) && value !== null) {
    return value;
  }

  if (isRecord(value) && isExcelErrorValue(value.error)) {
    return { error: value.error };
  }

  throw new Error('Unsupported Excel formula result');
}

/** Converts a public Excel value into an ExcelJS cell value. */
function toExcelJsCellValue(value: ExcelCellValue): CellValue {
  if (isScalarValue(value)) {
    return value;
  }

  if (!isRecord(value)) {
    throw new Error('Unsupported Excel cell value');
  }

  if (isExcelErrorValue(value.error)) {
    return { error: value.error };
  }

  if (isFormulaValue(value)) {
    const formulaValue = {
      formula: value.formula,
      ...(value.result !== undefined ? { result: toExcelJsFormulaResult(value.result) } : {}),
      ...(value.date1904 !== undefined ? { date1904: value.date1904 } : {}),
    };
    return formulaValue;
  }

  if (isSharedFormulaValue(value)) {
    const sharedFormulaValue = {
      sharedFormula: value.sharedFormula,
      ...(value.formula !== undefined ? { formula: value.formula } : {}),
      ...(value.result !== undefined ? { result: toExcelJsFormulaResult(value.result) } : {}),
      ...(value.date1904 !== undefined ? { date1904: value.date1904 } : {}),
    };
    return sharedFormulaValue;
  }

  if (isHyperlinkValue(value)) {
    return {
      text: value.text,
      hyperlink: value.hyperlink,
      ...(value.tooltip !== undefined ? { tooltip: value.tooltip } : {}),
    };
  }

  if (isRichTextValue(value)) {
    return { richText: value.richText.map((run) => ({ text: run.text })) };
  }

  throw new Error('Unsupported Excel cell value');
}

/** Converts a public formula result into an ExcelJS formula result. */
function toExcelJsFormulaResult(value: ExcelFormulaResult): ExcelFormulaResult {
  return value;
}

/** Maps ExcelJS validation details into the public validation model. */
function mapDataValidation(dataValidation: DataValidation | undefined): ExcelCellValidation {
  if (dataValidation === undefined) {
    return { hasValidation: false, formulae: [] };
  }

  const rawFormulae: unknown = dataValidation.formulae;
  const formulae: ExcelValidationFormula[] = [];
  if (Array.isArray(rawFormulae)) {
    for (const formula of rawFormulae as readonly unknown[]) {
      if (isValidationFormula(formula)) {
        formulae.push(formula);
      }
    }
  }

  return {
    hasValidation: true,
    type: dataValidation.type,
    ...(dataValidation.operator !== undefined ? { operator: dataValidation.operator } : {}),
    formulae,
    ...(dataValidation.allowBlank !== undefined ? { allowBlank: dataValidation.allowBlank } : {}),
    ...(dataValidation.error !== undefined ? { error: dataValidation.error } : {}),
    ...(dataValidation.errorTitle !== undefined ? { errorTitle: dataValidation.errorTitle } : {}),
    ...(dataValidation.errorStyle !== undefined ? { errorStyle: dataValidation.errorStyle } : {}),
    ...(dataValidation.prompt !== undefined ? { prompt: dataValidation.prompt } : {}),
    ...(dataValidation.promptTitle !== undefined
      ? { promptTitle: dataValidation.promptTitle }
      : {}),
    ...(dataValidation.showErrorMessage !== undefined
      ? { showErrorMessage: dataValidation.showErrorMessage }
      : {}),
    ...(dataValidation.showInputMessage !== undefined
      ? { showInputMessage: dataValidation.showInputMessage }
      : {}),
  };
}

/** Checks whether a cell range contains exactly one cell. */
function isSingleCell(range: CellRange): boolean {
  return range.start.row === range.end.row && range.start.column === range.end.column;
}

/** Checks whether a value is a supported scalar Excel value. */
function isScalarValue(value: unknown): value is ExcelScalarValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

/** Narrows an unknown value to a non-null record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Checks whether a value is a supported Excel error value. */
function isExcelErrorValue(value: unknown): value is ExcelErrorValue['error'] {
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

/** Checks whether a public value contains a formula. */
function isFormulaValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { formula: string }> {
  return isRecord(value) && typeof value.formula === 'string';
}

/** Checks whether a public value contains a shared formula. */
function isSharedFormulaValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { sharedFormula: string }> {
  return isRecord(value) && typeof value.sharedFormula === 'string';
}

/** Checks whether a public value contains a hyperlink. */
function isHyperlinkValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { hyperlink: string }> {
  return isRecord(value) && typeof value.hyperlink === 'string';
}

/** Checks whether a public value contains rich text runs. */
function isRichTextValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { richText: readonly { readonly text: string }[] }> {
  return isRecord(value) && Array.isArray(value.richText);
}

/** Checks whether a value is valid as a validation formula. */
function isValidationFormula(value: unknown): value is ExcelValidationFormula {
  return isScalarValue(value);
}

interface ValidatedWriteDataInput {
  readonly filePath: string;
  readonly sheetName?: string;
  readonly data: WriteDataInput['data'];
  readonly startCell: string;
}

/** Validates write input and maps empty data to the public error model. */
function parseWriteDataInput(input: WriteDataInput): ValidatedWriteDataInput {
  try {
    const validated = writeDataInputSchema.parse(input);
    return {
      filePath: validated.filePath,
      ...(validated.sheetName !== undefined ? { sheetName: validated.sheetName } : {}),
      data: input.data,
      startCell: validated.startCell,
    };
  } catch (cause) {
    if (isEmptyData(input)) {
      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.EMPTY_DATA,
        'No data provided to write',
        undefined,
        cause,
      );
    }
    throw cause;
  }
}

/** Checks whether write input contains no usable data. */
function isEmptyData(input: WriteDataInput): boolean {
  const data: unknown = input?.data;
  return (
    data === null ||
    data === undefined ||
    (Array.isArray(data) &&
      (data.length === 0 || data.some((row) => Array.isArray(row) && row.length === 0)))
  );
}
