import { AgentToolExecutionError } from '@opspilot/agent-runtime';

import type { ExcelResource } from '../excel-resource.js';
import type { ToolExecutionContext } from '../tool-context.js';

/** Resolves the Excel resource selected by a tool call or the current Turn default. */
export function resolveExcelResource(
  context: ToolExecutionContext,
  resourceId?: string,
): ExcelResource {
  if (context.excelResources.length === 0) {
    throw new AgentToolExecutionError(
      'No Excel workbook is attached to this Turn.',
      'EXCEL_RESOURCE_REQUIRED',
    );
  }

  if (resourceId !== undefined) {
    const resource = context.excelResources.find((candidate) => candidate.id === resourceId);
    if (resource !== undefined) return resource;

    throw new AgentToolExecutionError(
      `Excel resource "${resourceId}" is not available in this Turn.`,
      'EXCEL_RESOURCE_NOT_FOUND',
      { resourceId },
    );
  }

  if (context.excelResources.length === 1) return context.excelResources[0]!;

  const activeResource = context.excelResources.find(
    (resource) => resource.id === context.activeExcelResourceId,
  );
  if (activeResource !== undefined) return activeResource;

  throw new AgentToolExecutionError(
    'Multiple Excel resources are available. Specify resourceId.',
    'EXCEL_RESOURCE_SELECTION_REQUIRED',
  );
}

/** Requires an Excel resource using the current Turn default selection rules. */
export function requireExcelResource(context: ToolExecutionContext): ExcelResource {
  return resolveExcelResource(context);
}
