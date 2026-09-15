import type { JsonObject } from '@opspilot/model-gateway';
import type { ExcelFilterConnector, FilterDataResult } from '@opspilot/tool-gateway';

import { resolveExcelResource } from './require-excel-resource.js';
import {
  createExcelWorkingResourceRequest,
  type ExcelWorkingResourcePathResolver,
} from './excel-working-resource-request.js';
import {
  narrowExcelPredicateLogic,
  narrowExcelPredicates,
  narrowOptionalExcelResourceAlias,
  narrowOptionalExcelString,
  narrowRequiredExcelString,
  type ModelExcelPredicate,
} from './excel-query-arguments.js';
import type { ToolDefinition } from '../tool-definition.js';
import type { FilterDataToolDetails } from './excel-analysis-tool-details.js';

const MAX_MODEL_VISIBLE_FILTER_RANGES = 100;

const FILTER_DATA_PARAMETERS: JsonObject = {
  type: 'object',
  properties: {
    resource: {
      type: 'string',
      minLength: 1,
      description:
        'Logical alias of the Excel resource to operate on. Use one of the aliases available in the current Session.',
    },
    sheetName: { type: 'string', minLength: 1 },
    range: { type: 'string', minLength: 1 },
    conditions: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          column: { type: 'string', minLength: 1 },
          operator: {
            type: 'string',
            enum: [
              'equals',
              'notEquals',
              'greaterThan',
              'lessThan',
              'contains',
              'isEmpty',
              'isNotEmpty',
            ],
          },
          value: { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }] },
        },
        required: ['column', 'operator'],
        additionalProperties: false,
      },
    },
    logic: { type: 'string', enum: ['all', 'any'] },
  },
  required: ['sheetName', 'conditions'],
  additionalProperties: false,
};

interface FilterDataToolArguments {
  readonly resource?: string;
  readonly sheetName: string;
  readonly range?: string;
  readonly conditions: readonly ModelExcelPredicate[];
  readonly logic?: 'all' | 'any';
}

/** Creates the read-only Application Tool that locates matching Excel worksheet rows. */
export function createFilterDataTool(
  filterConnector: ExcelFilterConnector,
  workingResourceManager: ExcelWorkingResourcePathResolver,
): ToolDefinition<FilterDataToolDetails> {
  return {
    name: 'filter_data',
    description: 'Find Excel rows matching structured conditions and return their row ranges.',
    parameters: FILTER_DATA_PARAMETERS,
    recoveryPolicy: 'retry_safe',
    requiresExcelResource: true,
    async execute(_callId, args, signal, context) {
      const { resource, sheetName, range, conditions, logic } = narrowArguments(args);
      const excelResource = resolveExcelResource(context, resource);
      const filePath = await workingResourceManager.resolveReadablePath(
        createExcelWorkingResourceRequest(context, excelResource, signal),
      );
      const result = await filterConnector.filterData(
        {
          filePath,
          sheetName,
          ...(range === undefined ? {} : { range }),
          conditions,
          ...(logic === undefined ? {} : { logic }),
        },
        signal,
      );
      const details = toFilterDataToolDetails(result);

      return {
        content: [{ type: 'text', text: formatFilterResult(details) }],
        details,
      };
    },
  };
}

/** Narrows the JSON arguments after the Agent Runtime has checked the public schema. */
function narrowArguments(args: JsonObject): FilterDataToolArguments {
  const resource = narrowOptionalExcelResourceAlias(args.resource, 'filter_data');
  const sheetName = narrowRequiredExcelString(args.sheetName, 'sheetName', 'filter_data');
  const range = narrowOptionalExcelString(args.range, 'range', 'filter_data');
  const conditions = narrowExcelPredicates(args.conditions, 'filter_data');
  const logic = narrowExcelPredicateLogic(args.logic, 'filter_data');
  return {
    ...(resource === undefined ? {} : { resource }),
    sheetName,
    ...(range === undefined ? {} : { range }),
    conditions,
    ...(logic === undefined ? {} : { logic }),
  };
}

/** Projects the complete Gateway result into bounded Application Tool details. */
function toFilterDataToolDetails(result: FilterDataResult): FilterDataToolDetails {
  const matchedRanges = result.matchedRanges.slice(0, MAX_MODEL_VISIBLE_FILTER_RANGES);
  return {
    sheetName: result.sheetName,
    sourceRowCount: result.sourceRowCount,
    matchedRowCount: result.matchedRowCount,
    matchedRanges,
    totalRangeCount: result.matchedRanges.length,
    returnedRangeCount: matchedRanges.length,
    truncated: matchedRanges.length < result.matchedRanges.length,
  };
}

/** Formats row counts and a bounded range list without worksheet cell contents. */
function formatFilterResult(result: FilterDataToolDetails): string {
  const lines = [
    `sheetName: ${result.sheetName}`,
    `sourceRowCount: ${result.sourceRowCount}`,
    `matchedRowCount: ${result.matchedRowCount}`,
    `totalRangeCount: ${result.totalRangeCount}`,
    `returnedRangeCount: ${result.returnedRangeCount}`,
    'matchedRanges:',
    ...result.matchedRanges
      .map((range) => `${range.startRow}-${range.endRow}`),
  ];
  if (result.truncated) {
    lines.push(
      `Showing first ${result.returnedRangeCount} of ${result.totalRangeCount} matched ranges.`,
    );
  }
  return lines.join('\n');
}
