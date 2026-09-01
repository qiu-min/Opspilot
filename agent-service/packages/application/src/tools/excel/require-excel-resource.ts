import { AgentToolExecutionError } from '@opspilot/agent-runtime';

import type { ExcelResource } from '../excel-resource.js';
import type { ToolContext } from '../tool-context.js';

/** Requires an Excel resource at the boundary of an Excel Application Tool. */
export function requireExcelResource(context: ToolContext): ExcelResource {
  if (context.excelResource === undefined) {
    throw new AgentToolExecutionError(
      'No Excel workbook is attached to this conversation turn.',
      'EXCEL_RESOURCE_REQUIRED',
    );
  }

  return context.excelResource;
}
