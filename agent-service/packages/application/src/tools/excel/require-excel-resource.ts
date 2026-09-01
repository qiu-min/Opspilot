import type { ExcelResource } from '../excel-resource.js';
import type { ToolContext } from '../tool-context.js';

/** Requires an Excel resource at the boundary of an Excel Application Tool. */
export function requireExcelResource(context: ToolContext): ExcelResource {
  if (context.excelResource === undefined) {
    throw new Error('Excel tool requires an ExcelResource.');
  }

  return context.excelResource;
}
