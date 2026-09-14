import type { ExcelDiscoveryConnector, GetWorkbookInfoResult } from '@opspilot/tool-gateway';
import type { JsonObject } from '@opspilot/model-gateway';

import { resolveExcelResource } from './require-excel-resource.js';
import type { ToolDefinition } from '../tool-definition.js';

const GET_WORKBOOK_INFO_PARAMETERS: JsonObject = {
  type: 'object',
  properties: {
    resource: {
      type: 'string',
      minLength: 1,
      description:
        'Logical alias of the Excel resource to operate on. Use one of the aliases available in the current Session.',
    },
  },
  additionalProperties: false,
};

/** Creates the Application Tool that describes the workbook in the current Excel resource. */
export function createGetWorkbookInfoTool(
  discoveryConnector: ExcelDiscoveryConnector,
): ToolDefinition<GetWorkbookInfoResult> {
  return {
    name: 'get_workbook_info',
    description: 'Inspect the workbook structure and worksheet summaries.',
    parameters: GET_WORKBOOK_INFO_PARAMETERS,
    recoveryPolicy: 'retry_safe',
    requiresExcelResource: true,
    async execute(_callId, args, signal, context) {
      const resourceAlias = narrowResourceAlias(args);
      const excelResource = resolveExcelResource(context, resourceAlias);
      const result = await discoveryConnector.getWorkbookInfo(
        { filePath: excelResource.filePath },
        signal,
      );

      return {
        content: [{ type: 'text', text: formatWorkbookInfo(result) }],
        details: result,
      };
    },
  };
}

/** Narrows the optional resource selector after Agent Runtime validation. */
function narrowResourceAlias(args: JsonObject): string | undefined {
  const resourceAlias = args.resource;
  if (resourceAlias === undefined) return undefined;
  if (typeof resourceAlias !== 'string') {
    throw new TypeError('get_workbook_info resource must be a string when provided.');
  }

  return resourceAlias;
}

/** Formats workbook metadata as stable, compact text for the model context. */
function formatWorkbookInfo(result: GetWorkbookInfoResult): string {
  const lines = [`sheetCount: ${result.sheetCount}`];
  if (result.activeSheetName !== undefined) {
    lines.push(`activeSheetName: ${result.activeSheetName}`);
  }

  lines.push('sheets:');
  for (const sheet of result.sheets) {
    lines.push(
      `- name: ${sheet.name}; state: ${sheet.state}; usedRange: ${sheet.usedRange ?? 'null'}; ` +
        `rowCount: ${sheet.rowCount}; columnCount: ${sheet.columnCount}`,
    );
  }

  return lines.join('\n');
}
