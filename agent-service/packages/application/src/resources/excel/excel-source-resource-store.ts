import type { ExcelResource } from '../../tools/excel-resource.js';

/** Persists the runtime source locator for a Session-scoped Excel resource. */
export interface ExcelSourceResourceStore {
  /** Returns one source locator, or null when it is not available after restart. */
  get(sessionId: string, resourceId: string): Promise<ExcelResource | null>;

  /** Saves or replaces one source locator without changing Domain Session state. */
  save(sessionId: string, resource: ExcelResource): Promise<void>;
}
