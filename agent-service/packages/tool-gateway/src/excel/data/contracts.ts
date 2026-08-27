export type ExcelScalarValue = string | number | boolean | Date | null;

export interface ExcelErrorValue {
  readonly error: '#N/A' | '#REF!' | '#NAME?' | '#DIV/0!' | '#NULL!' | '#VALUE!' | '#NUM!';
}

export type ExcelFormulaResult = Exclude<ExcelScalarValue, null> | ExcelErrorValue;

export interface ExcelFormulaValue {
  readonly formula: string;
  readonly result?: ExcelFormulaResult;
  readonly date1904?: boolean;
}

export interface ExcelSharedFormulaValue {
  readonly sharedFormula: string;
  readonly formula?: string;
  readonly result?: ExcelFormulaResult;
  readonly date1904?: boolean;
}

export interface ExcelHyperlinkValue {
  readonly text: string;
  readonly hyperlink: string;
  readonly tooltip?: string;
}

export interface ExcelRichTextRun {
  readonly text: string;
}

export interface ExcelRichTextValue {
  readonly richText: readonly ExcelRichTextRun[];
}

export type ExcelCellValue =
  | ExcelScalarValue
  | ExcelErrorValue
  | ExcelFormulaValue
  | ExcelSharedFormulaValue
  | ExcelHyperlinkValue
  | ExcelRichTextValue;

export interface ReadRangeInput {
  readonly filePath: string;
  readonly sheetName: string;
  readonly startCell?: string;
  readonly endCell?: string;
}

export interface ReadRangeResult {
  readonly sheetName: string;
  readonly range: string;
  readonly values: readonly (readonly ExcelCellValue[])[];
}

export interface WriteDataInput {
  readonly filePath: string;
  readonly sheetName?: string;
  readonly data: readonly (readonly ExcelCellValue[])[];
  readonly startCell?: string;
}

export interface WriteDataResult {
  readonly sheetName: string;
  readonly range: string;
  readonly message: string;
}

export type ExcelValidationFormula = string | number | boolean | Date | null;

export interface ExcelCellValidation {
  readonly hasValidation: boolean;
  readonly type?: string;
  readonly operator?: string;
  readonly formulae: readonly ExcelValidationFormula[];
  readonly allowBlank?: boolean;
  readonly error?: string;
  readonly errorTitle?: string;
  readonly errorStyle?: string;
  readonly prompt?: string;
  readonly promptTitle?: string;
  readonly showErrorMessage?: boolean;
  readonly showInputMessage?: boolean;
}

export interface ExcelMetadataCell {
  readonly address: string;
  readonly row: number;
  readonly column: number;
  readonly value: ExcelCellValue;
  readonly validation?: ExcelCellValidation;
}

export interface ReadRangeWithMetadataInput {
  readonly filePath: string;
  readonly sheetName: string;
  readonly startCell?: string;
  readonly endCell?: string;
  readonly includeValidation?: boolean;
}

export interface ReadRangeWithMetadataResult {
  readonly sheetName: string;
  readonly range: string;
  readonly cells: readonly ExcelMetadataCell[];
}
