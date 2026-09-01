import type { ExcelDiscoveryConnector, GetWorkbookInfoResult } from '@opspilot/tool-gateway';
import type { JsonObject } from '@opspilot/model-gateway';

import { requireExcelResource } from './require-excel-resource.js';
import type { ToolDefinition } from '../tool-definition.js';

const GET_WORKBOOK_INFO_PARAMETERS: JsonObject = {
  type: 'object',
  properties: {},
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
    async execute(_callId, _args, signal, context) {
      const excelResource = requireExcelResource(context);
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
