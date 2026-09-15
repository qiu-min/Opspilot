import type { ExcelWorkingResourceManager } from '../../resources/excel/excel-working-resource-manager.js';
import type { ExcelWorkingResourceRequest } from '../../resources/excel/excel-working-resource.js';
import type { ExcelResource } from '../excel-resource.js';
import type { ToolExecutionContext } from '../tool-context.js';

/** The working-resource capability required by read-only Excel tools. */
export type ExcelWorkingResourcePathResolver = Pick<
  ExcelWorkingResourceManager,
  'resolveReadablePath'
>;

/** Builds the Session/resource identity used to resolve an effective Excel file path. */
export function createExcelWorkingResourceRequest(
  context: ToolExecutionContext,
  resource: ExcelResource,
  signal?: AbortSignal,
): ExcelWorkingResourceRequest {
  return {
    sessionId: context.sessionId,
    sourceResourceId: resource.id,
    sourcePath: resource.filePath,
    ...(signal === undefined ? {} : { signal }),
  };
}
