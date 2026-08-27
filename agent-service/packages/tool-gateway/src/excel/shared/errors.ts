export const ExcelCapabilityErrorCode = {
  WORKSHEET_NOT_FOUND: 'WORKSHEET_NOT_FOUND',
  INVALID_CELL_REFERENCE: 'INVALID_CELL_REFERENCE',
  EMPTY_DATA: 'EMPTY_DATA',
  NO_ACTIVE_WORKSHEET: 'NO_ACTIVE_WORKSHEET',
  WORKBOOK_OPEN_FAILED: 'WORKBOOK_OPEN_FAILED',
  WORKBOOK_SAVE_FAILED: 'WORKBOOK_SAVE_FAILED',
  EXCEL_OPERATION_FAILED: 'EXCEL_OPERATION_FAILED',
} as const;

export type ExcelCapabilityErrorCode =
  (typeof ExcelCapabilityErrorCode)[keyof typeof ExcelCapabilityErrorCode];

export type ExcelCapabilityErrorDetails = Readonly<Record<string, unknown>>;

export class ExcelCapabilityError extends Error {
  readonly name = 'ExcelCapabilityError';
  readonly code: ExcelCapabilityErrorCode;
  readonly details?: ExcelCapabilityErrorDetails;
  readonly cause?: unknown;

  constructor(
    code: ExcelCapabilityErrorCode,
    message: string,
    details?: ExcelCapabilityErrorDetails,
    cause?: unknown,
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isExcelCapabilityError(error: unknown): error is ExcelCapabilityError {
  return error instanceof ExcelCapabilityError;
}
