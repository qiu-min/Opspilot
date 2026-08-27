import type {
  GetSheetProfileInput,
  GetSheetProfileResult,
  GetWorkbookInfoInput,
  GetWorkbookInfoResult,
} from './contracts.js';

export interface ExcelDiscoveryConnector {
  getWorkbookInfo(
    input: GetWorkbookInfoInput,
    signal?: AbortSignal,
  ): Promise<GetWorkbookInfoResult>;
  getSheetProfile(
    input: GetSheetProfileInput,
    signal?: AbortSignal,
  ): Promise<GetSheetProfileResult>;
}
