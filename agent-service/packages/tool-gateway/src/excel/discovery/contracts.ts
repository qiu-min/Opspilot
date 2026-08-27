export type ExcelInferredType =
  'string' | 'number' | 'boolean' | 'date' | 'formula' | 'error' | 'mixed' | 'empty';

export interface GetWorkbookInfoInput {
  readonly filePath: string;
}

export interface WorkbookSheetSummary {
  readonly name: string;
  readonly index: number;
  readonly state: 'visible' | 'hidden' | 'veryHidden';
  readonly usedRange: string | null;
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface GetWorkbookInfoResult {
  readonly sheetCount: number;
  readonly activeSheetName?: string;
  readonly sheets: readonly WorkbookSheetSummary[];
}

export interface GetSheetProfileInput {
  readonly filePath: string;
  readonly sheetName: string;
  readonly sampleSize?: number;
}

export interface SheetColumnProfile {
  readonly index: number;
  readonly letter: string;
  readonly header: string | null;
  readonly inferredType: ExcelInferredType;
}

export interface GetSheetProfileResult {
  readonly sheetName: string;
  readonly usedRange: string | null;
  readonly rowCount: number;
  readonly columnCount: number;
  readonly headerRow: number | null;
  readonly sampledRowCount: number;
  readonly columns: readonly SheetColumnProfile[];
}
