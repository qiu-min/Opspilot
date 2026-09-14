import type {
  ExcelWorkingResource,
  ExcelWorkingResourceRequest,
} from './excel-working-resource.js';

/** Filesystem boundary for atomically initializing a complete working resource. */
export interface ExcelWorkingResourceFileOperator {
  /**
   * Initializes a working resource from its immutable source. Implementations own
   * staging, metadata creation, validation, and atomic publication details.
   */
  initializeWorkingResource(input: ExcelWorkingResourceRequest): Promise<ExcelWorkingResource>;
}
