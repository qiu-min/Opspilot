import type { JsonObject } from '@opspilot/model-gateway';
import type {
  AggregateDataResult,
  AggregateMetric,
  ExcelAggregateConnector,
} from '@opspilot/tool-gateway';

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
import type { AggregateDataToolDetails } from './excel-analysis-tool-details.js';

const MAX_MODEL_VISIBLE_AGGREGATE_ROWS = 100;

const AGGREGATE_DATA_PARAMETERS: JsonObject = {
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
    where: {
      type: 'object',
      properties: {
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
      required: ['conditions'],
      additionalProperties: false,
    },
    groupBy: { type: 'array', items: { type: 'string', minLength: 1 } },
    metrics: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          column: { type: 'string', minLength: 1 },
          operation: { type: 'string', enum: ['sum', 'count', 'average', 'min', 'max'] },
          alias: { type: 'string', minLength: 1 },
        },
        required: ['column', 'operation'],
        additionalProperties: false,
      },
    },
  },
  required: ['sheetName', 'metrics'],
  additionalProperties: false,
};

interface AggregateDataToolArguments {
  readonly resource?: string;
  readonly sheetName: string;
  readonly range?: string;
  readonly where?: {
    readonly conditions: readonly ModelExcelPredicate[];
    readonly logic?: 'all' | 'any';
  };
  readonly groupBy?: readonly string[];
  readonly metrics: readonly AggregateMetric[];
}

/** Creates the read-only Application Tool that aggregates the selected Excel worksheet. */
export function createAggregateDataTool(
  aggregateConnector: ExcelAggregateConnector,
  workingResourceManager: ExcelWorkingResourcePathResolver,
): ToolDefinition<AggregateDataToolDetails> {
  return {
    name: 'aggregate_data',
    description: 'Group and calculate metrics over Excel worksheet data.',
    parameters: AGGREGATE_DATA_PARAMETERS,
    recoveryPolicy: 'retry_safe',
    requiresExcelResource: true,
    async execute(_callId, args, signal, context) {
      const { resource, sheetName, range, where, groupBy, metrics } = narrowArguments(args);
      const excelResource = resolveExcelResource(context, resource);
      const filePath = await workingResourceManager.resolveReadablePath(
        createExcelWorkingResourceRequest(context, excelResource, signal),
      );
      const result = await aggregateConnector.aggregateData(
        {
          filePath,
          sheetName,
          ...(range === undefined ? {} : { range }),
          ...(where === undefined ? {} : { where }),
          ...(groupBy === undefined ? {} : { groupBy }),
          metrics,
        },
        signal,
      );
      const details = toAggregateDataToolDetails(result);

      return {
        content: [{ type: 'text', text: formatAggregateResult(details) }],
        details,
      };
    },
  };
}

/** Narrows the JSON arguments after the Agent Runtime has checked the public schema. */
function narrowArguments(args: JsonObject): AggregateDataToolArguments {
  const resource = narrowOptionalExcelResourceAlias(args.resource, 'aggregate_data');
  const sheetName = narrowRequiredExcelString(args.sheetName, 'sheetName', 'aggregate_data');
  const range = narrowOptionalExcelString(args.range, 'range', 'aggregate_data');
  const where = narrowOptionalWhere(args.where);
  const groupBy = narrowOptionalGroupBy(args.groupBy);
  const metrics = narrowMetrics(args.metrics);

  return {
    ...(resource === undefined ? {} : { resource }),
    sheetName,
    ...(range === undefined ? {} : { range }),
    ...(where === undefined ? {} : { where }),
    ...(groupBy === undefined ? {} : { groupBy }),
    metrics,
  };
}

/** Narrows optional where conditions while preserving omitted default logic. */
function narrowOptionalWhere(value: unknown): AggregateDataToolArguments['where'] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new TypeError('aggregate_data where must be an object.');
  const conditions = narrowExcelPredicates(value.conditions, 'aggregate_data');
  const logic = narrowExcelPredicateLogic(value.logic, 'aggregate_data');
  return { conditions, ...(logic === undefined ? {} : { logic }) };
}

/** Narrows optional grouping columns to non-empty names. */
function narrowOptionalGroupBy(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError('aggregate_data groupBy must be an array of column names.');
  }
  return (value as readonly unknown[]).map((column) =>
    narrowRequiredExcelString(column, 'groupBy column', 'aggregate_data'),
  );
}

/** Narrows the required list of supported aggregate metrics. */
function narrowMetrics(value: unknown): readonly AggregateMetric[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('aggregate_data metrics must contain at least one metric.');
  }

  return (value as readonly unknown[]).map((candidate) => {
    if (!isRecord(candidate)) {
      throw new TypeError('aggregate_data metrics must contain metric objects.');
    }
    const column = narrowRequiredExcelString(candidate.column, 'metric column', 'aggregate_data');
    const operation = candidate.operation;
    if (!isAggregateOperation(operation)) {
      throw new TypeError('aggregate_data metric operation is invalid.');
    }
    const alias = narrowOptionalExcelString(candidate.alias, 'metric alias', 'aggregate_data');
    return { column, operation, ...(alias === undefined ? {} : { alias }) };
  });
}

/** Checks the Gateway-supported aggregate operation enum. */
function isAggregateOperation(value: unknown): value is AggregateMetric['operation'] {
  return (
    value === 'sum' ||
    value === 'count' ||
    value === 'average' ||
    value === 'min' ||
    value === 'max'
  );
}

/** Projects the complete Gateway result into bounded Application Tool details. */
function toAggregateDataToolDetails(result: AggregateDataResult): AggregateDataToolDetails {
  const rows = result.rows.slice(0, MAX_MODEL_VISIBLE_AGGREGATE_ROWS);
  return {
    sheetName: result.sheetName,
    columns: result.columns,
    rows,
    sourceRowCount: result.sourceRowCount,
    resultRowCount: result.resultRowCount,
    returnedRowCount: rows.length,
    truncated: rows.length < result.resultRowCount,
  };
}

/** Formats stable, bounded worksheet aggregation text for the model. */
function formatAggregateResult(result: AggregateDataToolDetails): string {
  const lines = [
    `sheetName: ${result.sheetName}`,
    `sourceRowCount: ${result.sourceRowCount}`,
    `resultRowCount: ${result.resultRowCount}`,
    `returnedRowCount: ${result.returnedRowCount}`,
    'columns:',
    result.columns.map((column) => formatCellValue(column.name)).join(' | '),
    'rows:',
  ];

  for (const row of result.rows) {
    lines.push(row.map(formatCellValue).join(' | '));
  }
  if (result.truncated) {
    lines.push(
      `Showing first ${result.returnedRowCount} of ${result.resultRowCount} aggregate rows.`,
      'Refine groupBy / where to narrow the result.',
    );
  }
  return lines.join('\n');
}

/** Formats scalar and date values without leaking object representations. */
function formatCellValue(value: string | number | boolean | Date | null): string {
  if (value === null) return 'null';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  if (typeof value === 'string') {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/[\r\n]/g, '\\n');
  }
  return String(value);
}

/** Checks that a JSON value is a non-array object before reading named properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
