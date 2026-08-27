import {
  Workbook,
  type Cell,
  type CellValue,
  type DataValidation,
  type Worksheet,
} from 'exceljs';

import {
  ExcelCapabilityError,
  ExcelCapabilityErrorCode,
  isExcelCapabilityError,
} from '../errors.js';
import {
  formatCellAddress,
  formatCellRange,
  parseCellRange,
  type CellCoordinate,
  type CellRange,
} from '../cell-reference.js';
import {
  readRangeInputSchema,
  readRangeWithMetadataInputSchema,
  writeDataInputSchema,
} from '../schemas.js';
import type { ExcelDataConnector } from '../connectors/excel-data-connector.js';
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
} from '../contracts.js';

export class ExcelJsDataAdapter implements ExcelDataConnector {
  async readRange(input: ReadRangeInput, signal?: AbortSignal): Promise<ReadRangeResult> {
    const validated = readRangeInputSchema.parse(input);

    return this.execute('readRange', validated.filePath, signal, async () => {
      const workbook = await this.openWorkbook(validated.filePath, signal);
      const worksheet = this.requireWorksheet(workbook, validated.sheetName);
      const requested = parseRequestedRange(validated.startCell, validated.endCell);
      const resolved = resolveReadRange(worksheet, requested, false);

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

  async writeData(input: WriteDataInput, signal?: AbortSignal): Promise<WriteDataResult> {
    const validated = parseWriteDataInput(input);

    return this.execute('writeData', validated.filePath, signal, async () => {
      const workbook = await this.openWorkbook(validated.filePath, signal);
      const worksheet = validated.sheetName
        ? workbook.getWorksheet(validated.sheetName) ?? workbook.addWorksheet(validated.sheetName)
        : this.requireActiveWorksheet(workbook);
      const start = parseSingleCell(validated.startCell);

      for (let rowOffset = 0; rowOffset < validated.data.length; rowOffset += 1) {
        const row = validated.data[rowOffset];
        for (let columnOffset = 0; columnOffset < row.length; columnOffset += 1) {
          worksheet.getCell(start.row + rowOffset, start.column + columnOffset).value =
            toExcelJsCellValue(row[columnOffset]);
        }
      }

      await this.saveWorkbook(workbook, validated.filePath, signal);

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

  async readRangeWithMetadata(
    input: ReadRangeWithMetadataInput,
    signal?: AbortSignal,
  ): Promise<ReadRangeWithMetadataResult> {
    const validated = readRangeWithMetadataInputSchema.parse(input);

    return this.execute('readRangeWithMetadata', validated.filePath, signal, async () => {
      const workbook = await this.openWorkbook(validated.filePath, signal);
      const worksheet = this.requireWorksheet(workbook, validated.sheetName);
      const requested = parseRequestedRange(validated.startCell, validated.endCell);
      const resolved = resolveReadRange(worksheet, requested, true);

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

  private async execute<T>(
    operation: string,
    filePath: string,
    signal: AbortSignal | undefined,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      throwIfAborted(signal, operation);
      return await action();
    } catch (cause) {
      if (isExcelCapabilityError(cause)) {
        throw cause;
      }

      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.EXCEL_DATA_OPERATION_FAILED,
        `Failed to ${operation} Excel data`,
        { operation, filePath },
        cause,
      );
    }
  }

  private async openWorkbook(filePath: string, signal?: AbortSignal): Promise<Workbook> {
    throwIfAborted(signal, 'openWorkbook');
    const workbook = new Workbook();

    try {
      await workbook.xlsx.readFile(filePath);
      throwIfAborted(signal, 'openWorkbook');
      return workbook;
    } catch (cause) {
      if (isExcelCapabilityError(cause)) {
        throw cause;
      }

      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.WORKBOOK_OPEN_FAILED,
        `Failed to open workbook '${filePath}'`,
        { filePath },
        cause,
      );
    }
  }

  private async saveWorkbook(
    workbook: Workbook,
    filePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, 'saveWorkbook');

    try {
      await workbook.xlsx.writeFile(filePath);
      throwIfAborted(signal, 'saveWorkbook');
    } catch (cause) {
      if (isExcelCapabilityError(cause)) {
        throw cause;
      }

      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.WORKBOOK_SAVE_FAILED,
        `Failed to save workbook '${filePath}'`,
        { filePath },
        cause,
      );
    }
  }

  private requireWorksheet(workbook: Workbook, sheetName: string): Worksheet {
    const worksheet = workbook.getWorksheet(sheetName);
    if (!worksheet) {
      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.WORKSHEET_NOT_FOUND,
        `Worksheet '${sheetName}' not found`,
        { sheetName },
      );
    }

    return worksheet;
  }

  private requireActiveWorksheet(workbook: Workbook): Worksheet {
    const activeTab = workbook.views?.[0]?.activeTab;
    const worksheet =
      activeTab === undefined ? workbook.worksheets[0] : workbook.worksheets[activeTab];

    if (!worksheet) {
      throw new ExcelCapabilityError(
        ExcelCapabilityErrorCode.NO_ACTIVE_WORKSHEET,
        'No active worksheet found in workbook',
      );
    }

    return worksheet;
  }
}

interface RequestedRange {
  readonly range: CellRange;
  readonly isExplicit: boolean;
}

interface ResolvedReadRange {
  readonly range: CellRange;
  readonly hasData: boolean;
}

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

  if (
    startRange.start.row > endRange.end.row ||
    startRange.start.column > endRange.end.column
  ) {
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

function resolveReadRange(
  worksheet: Worksheet,
  requested: RequestedRange,
  metadataMode: boolean,
): ResolvedReadRange {
  const usedRange = findUsedRange(worksheet);

  if (
    requested.range.start.row > (usedRange?.end.row ?? 0) ||
    requested.range.start.column > (usedRange?.end.column ?? 0)
  ) {
    return { range: requested.range, hasData: false };
  }

  if (requested.isExplicit) {
    return { range: requested.range, hasData: Boolean(usedRange) };
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

function findUsedRange(worksheet: Worksheet): CellRange | undefined {
  let top = Number.POSITIVE_INFINITY;
  let left = Number.POSITIVE_INFINITY;
  let bottom = 0;
  let right = 0;

  worksheet.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      if (!hasCellContent(cell)) {
        return;
      }

      top = Math.min(top, cell.fullAddress.row);
      left = Math.min(left, cell.fullAddress.col);
      bottom = Math.max(bottom, cell.fullAddress.row);
      right = Math.max(right, cell.fullAddress.col);
    });
  });

  if (bottom === 0 || right === 0) {
    return undefined;
  }

  return {
    start: { row: top, column: left },
    end: { row: bottom, column: right },
  };
}

function hasCellContent(cell: Cell): boolean {
  return (
    (cell.value !== null && cell.value !== undefined) ||
    cell.dataValidation !== undefined
  );
}

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
      ...(value.result !== undefined
        ? { result: normalizeFormulaResult(value.result) }
        : {}),
      ...(typeof value.date1904 === 'boolean' ? { date1904: value.date1904 } : {}),
    };
  }

  if (typeof value.sharedFormula === 'string') {
    return {
      sharedFormula: value.sharedFormula,
      ...(typeof value.formula === 'string' ? { formula: value.formula } : {}),
      ...(value.result !== undefined
        ? { result: normalizeFormulaResult(value.result) }
        : {}),
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

function normalizeFormulaResult(value: unknown): ExcelFormulaResult {
  if (isScalarValue(value) && value !== null) {
    return value;
  }

  if (isRecord(value) && isExcelErrorValue(value.error)) {
    return { error: value.error };
  }

  throw new Error('Unsupported Excel formula result');
}

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

function toExcelJsFormulaResult(value: ExcelFormulaResult): ExcelFormulaResult {
  return value;
}

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
    ...(dataValidation.allowBlank !== undefined
      ? { allowBlank: dataValidation.allowBlank }
      : {}),
    ...(dataValidation.error !== undefined ? { error: dataValidation.error } : {}),
    ...(dataValidation.errorTitle !== undefined
      ? { errorTitle: dataValidation.errorTitle }
      : {}),
    ...(dataValidation.errorStyle !== undefined
      ? { errorStyle: dataValidation.errorStyle }
      : {}),
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

function isSingleCell(range: CellRange): boolean {
  return range.start.row === range.end.row && range.start.column === range.end.column;
}

function isScalarValue(value: unknown): value is ExcelScalarValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value instanceof Date
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

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

function isFormulaValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { formula: string }> {
  return isRecord(value) && typeof value.formula === 'string';
}

function isSharedFormulaValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { sharedFormula: string }> {
  return isRecord(value) && typeof value.sharedFormula === 'string';
}

function isHyperlinkValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { hyperlink: string }> {
  return isRecord(value) && typeof value.hyperlink === 'string';
}

function isRichTextValue(
  value: ExcelCellValue,
): value is Extract<ExcelCellValue, { richText: readonly { readonly text: string }[] }> {
  return isRecord(value) && Array.isArray(value.richText);
}

function isValidationFormula(value: unknown): value is ExcelValidationFormula {
  return isScalarValue(value);
}

interface ValidatedWriteDataInput {
  readonly filePath: string;
  readonly sheetName?: string;
  readonly data: WriteDataInput['data'];
  readonly startCell: string;
}

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

function isEmptyData(input: WriteDataInput): boolean {
  const data: unknown = input?.data;
  return (
    data === null ||
    data === undefined ||
    (Array.isArray(data) &&
      (data.length === 0 || data.some((row) => Array.isArray(row) && row.length === 0)))
  );
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.EXCEL_DATA_OPERATION_FAILED,
      `Excel data operation '${operation}' was cancelled`,
      { operation },
      signal.reason,
    );
  }
}
