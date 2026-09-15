import type { JsonObject } from '@opspilot/model-gateway';
import type {
  ExcelCellValue,
  ExcelDataConnector,
  ExcelFormulaResult,
} from '@opspilot/tool-gateway';

import { resolveExcelResource } from './require-excel-resource.js';
import {
  createExcelWorkingResourceRequest,
  type ExcelWorkingResourcePathResolver,
} from './excel-working-resource-request.js';
import {
  narrowOptionalExcelResourceAlias,
  narrowRequiredExcelString,
} from './excel-query-arguments.js';
import { measureExcelRange } from './excel-range-limit.js';
import type { ToolDefinition } from '../tool-definition.js';
import type {
  ReadRangeToolCellValue,
  ReadRangeToolDetails,
} from './excel-analysis-tool-details.js';

export const MAX_READ_RANGE_CELLS = 500;
export const MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH = 2_000;

const TRUNCATED_CELL_TEXT_MARKER = '...[truncated]';

const READ_RANGE_PARAMETERS: JsonObject = {
  type: 'object',
  properties: {
    resource: {
      type: 'string',
      minLength: 1,
      description:
        'Logical alias of the Excel resource to operate on. Use one of the aliases available in the current Session.',
    },
    sheetName: { type: 'string', minLength: 1 },
    range: {
      type: 'string',
      minLength: 1,
      description: 'Explicit A1-style range to read, for example A1:D20.',
    },
  },
  required: ['sheetName', 'range'],
  additionalProperties: false,
};

interface ReadRangeToolArguments {
  readonly resource?: string;
  readonly sheetName: string;
  readonly range: string;
}

interface ProjectedCellValue {
  readonly value: ReadRangeToolCellValue;
  readonly truncated: boolean;
}

/** Creates a bounded read-only Application Tool for explicit worksheet ranges. */
export function createReadRangeTool(
  dataConnector: Pick<ExcelDataConnector, 'readRange'>,
  workingResourceManager: ExcelWorkingResourcePathResolver,
): ToolDefinition<ReadRangeToolDetails> {
  return {
    name: 'read_range',
    description: 'Read a small, explicitly selected Excel worksheet range.',
    parameters: READ_RANGE_PARAMETERS,
    recoveryPolicy: 'retry_safe',
    requiresExcelResource: true,
    async execute(_callId, args, signal, context) {
      const { resource, sheetName, range } = narrowArguments(args);
      const requestShape = measureExcelRange(range);
      assertReadRangeWithinLimit(requestShape.cellCount);

      const excelResource = resolveExcelResource(context, resource);
      const filePath = await workingResourceManager.resolveReadablePath(
        createExcelWorkingResourceRequest(context, excelResource, signal),
      );
      const result = await dataConnector.readRange({ filePath, sheetName, range }, signal);
      const details = toReadRangeToolDetails(result.sheetName, result.range, result.values);

      return {
        content: [{ type: 'text', text: formatReadRangeResult(details) }],
        details,
      };
    },
  };
}

/** Narrows JSON arguments and enforces the model-facing required range contract. */
function narrowArguments(args: JsonObject): ReadRangeToolArguments {
  const resource = narrowOptionalExcelResourceAlias(args.resource, 'read_range');
  const sheetName = narrowRequiredExcelString(args.sheetName, 'sheetName', 'read_range');
  const range = narrowRequiredExcelString(args.range, 'range', 'read_range');
  return {
    ...(resource === undefined ? {} : { resource }),
    sheetName,
    range,
  };
}

/** Rejects oversized requests before resolving or opening a workbook. */
function assertReadRangeWithinLimit(cellCount: number): void {
  if (cellCount > MAX_READ_RANGE_CELLS) {
    throw new RangeError(
      `read_range range exceeds the ${MAX_READ_RANGE_CELLS}-cell limit. ` +
        'Request a smaller explicit range or use aggregate_data/filter_data.',
    );
  }
}

/** Projects the Gateway result into a rectangular, bounded Session-safe contract. */
function toReadRangeToolDetails(
  sheetName: string,
  range: string,
  values: readonly (readonly ExcelCellValue[])[],
): ReadRangeToolDetails {
  if (!Array.isArray(values)) {
    throw new TypeError('read_range Gateway result values must be a rectangular array.');
  }

  const rows = values as readonly (readonly ExcelCellValue[])[];
  const rowCount = rows.length;
  const columnCount = rowCount === 0 ? 0 : validateRowsAndGetColumnCount(rows);
  const cellCount = multiplyReturnedShape(rowCount, columnCount);
  if (cellCount > MAX_READ_RANGE_CELLS) {
    throw new RangeError(
      `read_range Gateway result exceeds the ${MAX_READ_RANGE_CELLS}-cell limit.`,
    );
  }

  let truncatedCellValueCount = 0;
  const projectedValues = rows.map((row) =>
    row.map((cell) => {
      const projected = projectCellValue(cell);
      if (projected.truncated) truncatedCellValueCount += 1;
      return projected;
    }),
  );

  return {
    sheetName,
    range,
    rowCount,
    columnCount,
    cellCount,
    values: projectedValues.map((row) => row.map((cell) => cell.value)),
    truncatedCellValueCount,
  };
}

/** Validates rectangular row lengths and returns the common column count. */
function validateRowsAndGetColumnCount(values: readonly (readonly ExcelCellValue[])[]): number {
  const firstRow = values[0];
  if (!Array.isArray(firstRow)) {
    throw new TypeError('read_range Gateway result values must contain row arrays.');
  }
  const columnCount = firstRow.length;
  for (const row of values) {
    if (!Array.isArray(row) || row.length !== columnCount) {
      throw new TypeError('read_range Gateway result rows must have consistent lengths.');
    }
  }
  return columnCount;
}

/** Checks that the returned matrix dimensions have a safe integer cell count. */
function multiplyReturnedShape(rowCount: number, columnCount: number): number {
  if (
    !Number.isSafeInteger(rowCount) ||
    !Number.isSafeInteger(columnCount) ||
    rowCount < 0 ||
    columnCount < 0
  ) {
    throw new RangeError('read_range Gateway result dimensions exceed safe integer limits.');
  }
  const cellCount = BigInt(rowCount) * BigInt(columnCount);
  if (cellCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('read_range Gateway result dimensions exceed safe integer limits.');
  }
  return Number(cellCount);
}

/** Converts one Excel value to a JSON-friendly value and bounded display text. */
function projectCellValue(value: ExcelCellValue): ProjectedCellValue {
  if (value === null) return { value: null, truncated: false };
  if (typeof value === 'boolean') {
    return { value, truncated: false };
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return projectStringValue(String(value));
    return { value, truncated: false };
  }
  if (typeof value === 'string') return projectStringValue(value);
  if (value instanceof Date) {
    return projectStringValue(Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString());
  }
  if ('error' in value) return projectStringValue(value.error);
  if ('sharedFormula' in value) {
    return projectStringValue(
      `sharedFormula:=${value.sharedFormula}, ` +
        `formula:=${value.formula ?? 'unknown'}, result:${formatFormulaResult(value.result)}`,
    );
  }
  if ('formula' in value) {
    return projectStringValue(
      `formula:=${value.formula}, result:${formatFormulaResult(value.result)}`,
    );
  }
  if ('hyperlink' in value) {
    return projectStringValue(`${value.text} <${value.hyperlink}>`);
  }
  if ('richText' in value) {
    return projectStringValue(value.richText.map((run) => run.text).join(''));
  }
  return assertUnsupportedExcelCellValue(value);
}

/** Bounds string-like values for both ToolResult content and persisted details. */
function projectStringValue(value: string): ProjectedCellValue {
  const detailsProjection = truncateCellText(value);
  const escapedDisplay = escapeCellText(detailsProjection.text);
  const displayProjection = truncateCellText(escapedDisplay);
  return {
    value: detailsProjection.text,
    truncated: detailsProjection.truncated || displayProjection.truncated,
  };
}

/** Formats optional formula results without using object string coercion. */
function formatFormulaResult(value: ExcelFormulaResult | undefined): string {
  if (value === undefined) return 'unknown';
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  }
  return value.error;
}

/** Escapes table delimiters and line breaks in a single cell's display value. */
function escapeCellText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/[\r\n]/g, '\\n');
}

/** Truncates one string-like cell projection while retaining an explicit marker. */
function truncateCellText(value: string): { readonly text: string; readonly truncated: boolean } {
  if (value.length <= MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH) {
    return { text: value, truncated: false };
  }
  const visibleLength = MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH - TRUNCATED_CELL_TEXT_MARKER.length;
  return {
    text: `${value.slice(0, visibleLength)}${TRUNCATED_CELL_TEXT_MARKER}`,
    truncated: true,
  };
}

/** Formats a structured read result as stable, compact model-visible text. */
function formatReadRangeResult(result: ReadRangeToolDetails): string {
  const lines = [
    `sheetName: ${result.sheetName}`,
    `range: ${result.range}`,
    `rowCount: ${result.rowCount}`,
    `columnCount: ${result.columnCount}`,
    `cellCount: ${result.cellCount}`,
    ...(result.truncatedCellValueCount === 0
      ? []
      : [`truncatedCellValueCount: ${result.truncatedCellValueCount}`]),
    'values:',
  ];

  for (const row of result.values) {
    lines.push(row.map(formatProjectedCellValue).join(' | '));
  }
  return lines.join('\n');
}

/** Displays a projected value without converting structured Excel values to objects. */
function formatProjectedCellValue(value: ReadRangeToolCellValue): string {
  if (value === null || typeof value !== 'string') return String(value);
  return truncateCellText(escapeCellText(value)).text;
}

/** Fails closed if a future Gateway contract adds an unhandled object value. */
function assertUnsupportedExcelCellValue(value: never): never {
  throw new TypeError(
    `read_range Gateway returned an unsupported Excel cell value: ${typeof value}.`,
  );
}
