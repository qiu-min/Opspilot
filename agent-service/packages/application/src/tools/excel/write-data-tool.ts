import type { JsonObject } from '@opspilot/model-gateway';
import type { ExcelDataConnector, WriteDataResult } from '@opspilot/tool-gateway';

import type { ExcelWorkingResourceManager } from '../../resources/excel/excel-working-resource-manager.js';
import { resolveExcelResource } from './require-excel-resource.js';
import { createExcelWorkingResourceRequest } from './excel-working-resource-request.js';
import type { ToolDefinition } from '../tool-definition.js';
import { createToolMutationId } from '../tool-mutation-id.js';

const WRITE_DATA_PARAMETERS: JsonObject = {
  type: 'object',
  properties: {
    resource: {
      type: 'string',
      minLength: 1,
      description:
        'Logical alias of the Excel resource to operate on. Use one of the aliases available in the current Session.',
    },
    sheetName: { type: 'string', minLength: 1 },
    startCell: { type: 'string', minLength: 1 },
    data: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'array',
        minItems: 1,
        items: {
          anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
        },
      },
    },
  },
  required: ['data'],
  additionalProperties: false,
};

type JsonNativeExcelScalar = string | number | boolean | null;
type ExcelWorkingResourceMutationManager = Pick<ExcelWorkingResourceManager, 'executeMutation'>;

interface WriteDataToolArguments {
  readonly resource?: string;
  readonly sheetName?: string;
  readonly startCell?: string;
  readonly data: readonly (readonly JsonNativeExcelScalar[])[];
}

/** Creates the Application Tool that atomically writes tabular data to a Session-owned workbook. */
export function createWriteDataTool(
  dataConnector: ExcelDataConnector,
  workingResourceManager: ExcelWorkingResourceMutationManager,
): ToolDefinition<WriteDataResult> {
  return {
    name: 'write_data',
    description: 'Write structured tabular data into the selected Excel worksheet.',
    parameters: WRITE_DATA_PARAMETERS,
    recoveryPolicy: 'retry_safe',
    requiresExcelResource: true,
    async execute(callId, args, signal, context) {
      const { resource, sheetName, startCell, data } = narrowWriteDataArguments(args);
      const excelResource = resolveExcelResource(context, resource);
      const request = createExcelWorkingResourceRequest(context, excelResource, signal);
      const mutationId = createToolMutationId(context.turnId, callId);
      const mutation = await workingResourceManager.executeMutation(
        { ...request, mutationId },
        async ({ stagingPath }) =>
          await dataConnector.writeData(
            {
              filePath: stagingPath,
              data,
              ...(sheetName === undefined ? {} : { sheetName }),
              ...(startCell === undefined ? {} : { startCell }),
            },
            signal,
          ),
      );
      const result = narrowWriteDataReceipt(mutation.receipt);

      return {
        content: [{ type: 'text', text: formatWriteDataResult(result) }],
        details: result,
      };
    },
  };
}

/** Narrows model arguments and rejects non-rectangular or non-JSON-scalar data. */
function narrowWriteDataArguments(args: JsonObject): WriteDataToolArguments {
  const resource = readOptionalNonEmptyString(args.resource, 'resource');
  const sheetName = readOptionalNonEmptyString(args.sheetName, 'sheetName');
  const startCell = readOptionalNonEmptyString(args.startCell, 'startCell');
  return {
    ...(resource === undefined ? {} : { resource }),
    ...(sheetName === undefined ? {} : { sheetName }),
    ...(startCell === undefined ? {} : { startCell }),
    data: narrowRectangularData(args.data),
  };
}

/** Validates that an optional tool argument is a non-empty string. */
function readOptionalNonEmptyString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`write_data ${name} must be a non-empty string when provided.`);
  }
  return value;
}

/** Validates and narrows a non-empty rectangular matrix of JSON-native Excel scalars. */
function narrowRectangularData(value: unknown): readonly (readonly JsonNativeExcelScalar[])[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('write_data data must contain at least one row.');
  }

  const rows: readonly unknown[] = value;
  const data: JsonNativeExcelScalar[][] = [];
  let expectedColumnCount: number | undefined;

  for (const rowValue of rows) {
    if (!Array.isArray(rowValue) || rowValue.length === 0) {
      throw new TypeError('write_data rows must contain at least one cell.');
    }

    const row: readonly unknown[] = rowValue;
    if (expectedColumnCount === undefined) expectedColumnCount = row.length;
    if (row.length !== expectedColumnCount) {
      throw new TypeError('write_data data must be rectangular.');
    }

    const cells: JsonNativeExcelScalar[] = [];
    for (const cell of row) {
      if (!isJsonNativeExcelScalar(cell)) {
        throw new TypeError('write_data cells must be strings, finite numbers, booleans, or null.');
      }
      cells.push(cell);
    }
    data.push(cells);
  }

  return data;
}

/** Checks whether one cell value belongs to the supported first-version scalar set. */
function isJsonNativeExcelScalar(value: unknown): value is JsonNativeExcelScalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Narrows the durable opaque receipt back to the current write_data result contract. */
function narrowWriteDataReceipt(value: unknown): WriteDataResult {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sheetName' in value) ||
    !('range' in value) ||
    !('message' in value) ||
    typeof value.sheetName !== 'string' ||
    typeof value.range !== 'string' ||
    typeof value.message !== 'string'
  ) {
    throw new TypeError('Persisted write_data receipt is invalid.');
  }
  return {
    sheetName: value.sheetName,
    range: value.range,
    message: value.message,
  };
}

/** Formats the successful Gateway result without including internal resource paths. */
function formatWriteDataResult(result: WriteDataResult): string {
  return [
    `sheetName: ${result.sheetName}`,
    `range: ${result.range}`,
    `message: ${result.message}`,
  ].join('\n');
}
