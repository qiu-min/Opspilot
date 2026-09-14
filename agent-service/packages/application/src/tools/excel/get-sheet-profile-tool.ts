import type { ExcelDiscoveryConnector, GetSheetProfileResult } from '@opspilot/tool-gateway';
import type { JsonObject } from '@opspilot/model-gateway';

import { resolveExcelResource } from './require-excel-resource.js';
import type { ToolDefinition } from '../tool-definition.js';

const GET_SHEET_PROFILE_PARAMETERS: JsonObject = {
  type: 'object',
  properties: {
    resource: {
      type: 'string',
      minLength: 1,
      description:
        'Logical alias of the Excel resource to operate on. Use one of the aliases available in the current Session.',
    },
    sheetName: { type: 'string', minLength: 1 },
    sampleSize: { type: 'integer', minimum: 1, maximum: 200 },
  },
  required: ['sheetName'],
  additionalProperties: false,
};

interface GetSheetProfileToolArguments {
  readonly sheetName: string;
  readonly sampleSize?: number;
  readonly resource?: string;
}

/** Creates the Application Tool that profiles one worksheet in the current Excel resource. */
export function createGetSheetProfileTool(
  discoveryConnector: ExcelDiscoveryConnector,
): ToolDefinition<GetSheetProfileResult> {
  return {
    name: 'get_sheet_profile',
    description: 'Inspect one worksheet range, header, and inferred column types.',
    parameters: GET_SHEET_PROFILE_PARAMETERS,
    recoveryPolicy: 'retry_safe',
    requiresExcelResource: true,
    async execute(_callId, args, signal, context) {
      const { sheetName, sampleSize, resource } = narrowArguments(args);
      const excelResource = resolveExcelResource(context, resource);
      const input = {
        filePath: excelResource.filePath,
        sheetName,
        ...(sampleSize === undefined ? {} : { sampleSize }),
      };
      const result = await discoveryConnector.getSheetProfile(input, signal);

      return {
        content: [{ type: 'text', text: formatSheetProfile(result) }],
        details: result,
      };
    },
  };
}

/** Narrows arguments that have already passed the Agent Runtime schema validation. */
function narrowArguments(args: JsonObject): GetSheetProfileToolArguments {
  const resource = args.resource;
  if (resource !== undefined && typeof resource !== 'string') {
    throw new TypeError('get_sheet_profile resource must be a string when provided.');
  }

  const sheetName = args.sheetName;
  if (typeof sheetName !== 'string') {
    throw new TypeError('get_sheet_profile requires a string sheetName argument.');
  }

  const sampleSize = args.sampleSize;
  if (sampleSize !== undefined && typeof sampleSize !== 'number') {
    throw new TypeError('get_sheet_profile sampleSize must be a number when provided.');
  }

  return {
    sheetName,
    ...(resource === undefined ? {} : { resource }),
    ...(sampleSize === undefined ? {} : { sampleSize }),
  };
}

/** Formats a sheet profile as stable, compact text for the model context. */
function formatSheetProfile(result: GetSheetProfileResult): string {
  const lines = [
    `sheetName: ${result.sheetName}`,
    `usedRange: ${result.usedRange ?? 'null'}`,
    `rowCount: ${result.rowCount}`,
    `columnCount: ${result.columnCount}`,
    `headerRow: ${result.headerRow ?? 'null'}`,
    `headerConfidence: ${result.headerConfidence}`,
    `sampledRowCount: ${result.sampledRowCount}`,
    'columns:',
  ];

  for (const column of result.columns) {
    lines.push(
      `- letter: ${column.letter}; header: ${column.header ?? 'null'}; ` +
        `inferredType: ${column.inferredType}`,
    );
  }

  return lines.join('\n');
}
