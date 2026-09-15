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
): ToolDefinition<FilterDataResult> {
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
      const boundedResult = boundFilterResult(result);

      return {
        content: [{ type: 'text', text: formatFilterResult(result) }],
        details: boundedResult,
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

/** Keeps persisted details within the same range limit used for model-visible content. */
function boundFilterResult(result: FilterDataResult): FilterDataResult {
  if (result.matchedRanges.length <= MAX_MODEL_VISIBLE_FILTER_RANGES) return result;
  return {
    ...result,
    matchedRanges: result.matchedRanges.slice(0, MAX_MODEL_VISIBLE_FILTER_RANGES),
  };
}

/** Formats row counts and a bounded range list without worksheet cell contents. */
function formatFilterResult(result: FilterDataResult): string {
  const lines = [
    `sheetName: ${result.sheetName}`,
    `sourceRowCount: ${result.sourceRowCount}`,
    `matchedRowCount: ${result.matchedRowCount}`,
    'matchedRanges:',
    ...result.matchedRanges
      .slice(0, MAX_MODEL_VISIBLE_FILTER_RANGES)
      .map((range) => `${range.startRow}-${range.endRow}`),
  ];
  if (result.matchedRanges.length > MAX_MODEL_VISIBLE_FILTER_RANGES) {
    lines.push(
      `Showing first ${MAX_MODEL_VISIBLE_FILTER_RANGES} of ${result.matchedRanges.length} matched ranges.`,
    );
  }
  return lines.join('\n');
}
