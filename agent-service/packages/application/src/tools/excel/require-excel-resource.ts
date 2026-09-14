import { AgentToolExecutionError } from '@opspilot/agent-runtime';

import type { ExcelResource } from '../excel-resource.js';
import type { ToolExecutionContext } from '../tool-context.js';

/** Resolves the Excel resource selected by a tool call or the current Turn default. */
export function resolveExcelResource(
  context: ToolExecutionContext,
  resourceAlias?: string,
): ExcelResource {
  if (context.excelResources.length === 0) {
    throw new AgentToolExecutionError(
      'No Excel workbook is attached to this Turn.',
      'EXCEL_RESOURCE_REQUIRED',
    );
  }

  if (resourceAlias !== undefined) {
    const resourceRef = context.excelResourceRefs.find(
      (candidate) => candidate.alias === resourceAlias,
    );
    const resource =
      resourceRef === undefined
        ? undefined
        : context.excelResources.find((candidate) => candidate.id === resourceRef.id);
    if (resource !== undefined) return resource;

    throw new AgentToolExecutionError(
      `Unknown Excel resource: ${resourceAlias}`,
      'EXCEL_RESOURCE_NOT_FOUND',
      { resource: resourceAlias },
    );
  }

  if (context.excelResources.length === 1) return context.excelResources[0]!;

  const activeResource = context.excelResources.find(
    (resource) => resource.id === context.activeExcelResourceId,
  );
  if (activeResource !== undefined) return activeResource;

  throw new AgentToolExecutionError(
    'Multiple Excel resources are available. Specify resource.',
    'EXCEL_RESOURCE_SELECTION_REQUIRED',
  );
}

/** Requires an Excel resource using the current Turn default selection rules. */
export function requireExcelResource(context: ToolExecutionContext): ExcelResource {
  return resolveExcelResource(context);
}
