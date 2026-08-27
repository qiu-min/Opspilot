import type {
  GetSheetProfileInput,
  GetSheetProfileResult,
  GetWorkbookInfoInput,
  GetWorkbookInfoResult,
} from './contracts.js';

export interface ExcelDiscoveryConnector {
  /** Inspects workbook structure and returns sheet summaries. */
  getWorkbookInfo(
    input: GetWorkbookInfoInput,
    signal?: AbortSignal,
  ): Promise<GetWorkbookInfoResult>;
  /** Profiles one worksheet's used range, headers, and sampled column types. */
  getSheetProfile(
    input: GetSheetProfileInput,
    signal?: AbortSignal,
  ): Promise<GetSheetProfileResult>;
}
