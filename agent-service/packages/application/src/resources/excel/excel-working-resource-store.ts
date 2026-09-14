import type { ExcelWorkingResource } from './excel-working-resource.js';

/** Application persistence boundary for Session-scoped Excel working resources. */
export interface ExcelWorkingResourceStore {
  get(
    sessionId: string,
    sourceResourceId: string,
    signal?: AbortSignal,
  ): Promise<ExcelWorkingResource | null>;

  save(resource: ExcelWorkingResource, signal?: AbortSignal): Promise<void>;

  delete?(sessionId: string, sourceResourceId: string, signal?: AbortSignal): Promise<void>;
}
