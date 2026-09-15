import type { ExcelWorkingResource } from './excel-working-resource.js';
import type { ExcelWorkingMutationReceiptRecord } from './excel-working-resource.js';

/** Application persistence boundary for Session-scoped Excel working resources. */
export interface ExcelWorkingResourceStore {
  get(
    sessionId: string,
    sourceResourceId: string,
    signal?: AbortSignal,
  ): Promise<ExcelWorkingResource | null>;

  getMutationReceipt(
    sessionId: string,
    sourceResourceId: string,
    mutationId: string,
    signal?: AbortSignal,
  ): Promise<ExcelWorkingMutationReceiptRecord | null>;

  delete?(sessionId: string, sourceResourceId: string, signal?: AbortSignal): Promise<void>;
}
