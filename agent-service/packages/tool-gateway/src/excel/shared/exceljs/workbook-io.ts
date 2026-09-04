import ExcelJS from "exceljs";
import type { Worksheet } from "exceljs";

import {
  ExcelCapabilityError,
  ExcelCapabilityErrorCode,
  isExcelCapabilityError,
} from '../errors.js';

/** Executes an Excel operation and normalizes unexpected failures. */
export async function executeExcelOperation<T>(
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
      ExcelCapabilityErrorCode.EXCEL_OPERATION_FAILED,
      "Failed to execute Excel operation '" + operation + "'",
      { operation, filePath },
      cause,
    );
  }
}

/** Opens an Excel workbook after checking cancellation. */
export async function openWorkbook(filePath: string, signal?: AbortSignal): Promise<ExcelJS.Workbook> {
  throwIfAborted(signal, 'openWorkbook');
  const workbook = new ExcelJS.Workbook();

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
      "Failed to open workbook '" + filePath + "'",
      { filePath },
      cause,
    );
  }
}

/** Saves an Excel workbook after checking cancellation. */
export async function saveWorkbook(
  workbook: ExcelJS.Workbook,
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
      "Failed to save workbook '" + filePath + "'",
      { filePath },
      cause,
    );
  }
}

/** Returns the workbook's active worksheet when one is available. */
export function getActiveWorksheet(workbook: ExcelJS.Workbook): Worksheet | undefined {
  const activeTab = workbook.views?.[0]?.activeTab;
  return activeTab === undefined ? workbook.worksheets[0] : workbook.worksheets[activeTab];
}

/** Returns a named worksheet or throws a worksheet-not-found error. */
export function requireWorksheet(workbook: ExcelJS.Workbook, sheetName: string): Worksheet {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.WORKSHEET_NOT_FOUND,
      "Worksheet '" + sheetName + "' not found",
      { sheetName },
    );
  }

  return worksheet;
}

/** Throws the standardized cancellation error when the operation is aborted. */
export function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new ExcelCapabilityError(
      ExcelCapabilityErrorCode.EXCEL_OPERATION_FAILED,
      "Excel operation '" + operation + "' was cancelled",
      { operation },
      signal.reason,
    );
  }
}
