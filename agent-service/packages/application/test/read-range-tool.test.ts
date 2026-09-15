import { describe, expect, it, vi } from 'vitest';
import type { ExcelCellValue, ExcelDataConnector, ReadRangeResult } from '@opspilot/tool-gateway';

import {
  createReadRangeTool,
  MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH,
  MAX_READ_RANGE_CELLS,
  type ToolContext,
} from '../src/index.js';

const resourceA = { id: 'resource-a', filePath: '/source/a.xlsx' };
const resourceB = { id: 'resource-b', filePath: '/source/b.xlsx' };
const context: ToolContext = {
  turnId: 'turn-read-range',
  sessionId: 'session-read-range',
  excelResources: [resourceA, resourceB],
  excelResourceRefs: [
    { id: resourceA.id, kind: 'excel', alias: 'excel-1' },
    { id: resourceB.id, kind: 'excel', alias: 'excel-2' },
  ],
  activeExcelResourceId: resourceB.id,
};

describe('read_range Application Tool', () => {
  it('requires a range and declares retry-safe, bounded parameters', async () => {
    const readRange = vi.fn<ExcelDataConnector['readRange']>(async () => makeResult([]));
    const manager = createWorkingResourceManager();
    const tool = createReadRangeTool({ readRange }, manager);

    expect(tool.parameters).toMatchObject({
      required: ['sheetName', 'range'],
      additionalProperties: false,
      properties: {
        range: {
          type: 'string',
          minLength: 1,
          description: 'Explicit A1-style range to read, for example A1:D20.',
        },
      },
    });
    expect(tool.recoveryPolicy).toBe('retry_safe');
    await expect(
      tool.execute('missing-range', { sheetName: 'Sales' }, undefined, context),
    ).rejects.toThrow('read_range requires a non-empty range string.');
    expect(manager.resolveReadablePath).not.toHaveBeenCalled();
    expect(readRange).not.toHaveBeenCalled();
  });

  it('routes a resource alias to that resource even when another resource is active', async () => {
    const signal = new AbortController().signal;
    const result = makeResult([['North', 1200]], 'A1:B1');
    const readRange = vi.fn<ExcelDataConnector['readRange']>(async () => result);
    const manager = createWorkingResourceManager((request) =>
      request.sourceResourceId === resourceA.id ? '/working/a/revision-1.xlsx' : request.sourcePath,
    );
    const tool = createReadRangeTool({ readRange }, manager);

    const output = await tool.execute(
      'read-call',
      { resource: 'excel-1', sheetName: 'Sales', range: 'A1:B1' },
      signal,
      context,
    );

    expect(manager.resolveReadablePath).toHaveBeenCalledWith({
      sessionId: context.sessionId,
      sourceResourceId: resourceA.id,
      sourcePath: resourceA.filePath,
      signal,
    });
    expect(readRange).toHaveBeenCalledWith(
      {
        filePath: '/working/a/revision-1.xlsx',
        sheetName: 'Sales',
        range: 'A1:B1',
      },
      signal,
    );
    expect(output.details).toMatchObject({
      sheetName: 'Sales',
      range: 'A1:B1',
      rowCount: 1,
      columnCount: 2,
      cellCount: 2,
      values: [['North', 1200]],
      truncatedCellValueCount: 0,
    });
    const content = textContent(output.content);
    expect(content).toContain('North | 1200');
    expect(content).not.toContain('/working/');
    expect(content).not.toContain('resource-a');
    expect(content).not.toContain('revision-1');
    expect(JSON.stringify(output)).not.toContain('/working/');
    expect(JSON.stringify(output)).not.toContain('/source/');
  });

  it('passes the source path through the readable-resource resolver when no working copy exists', async () => {
    const readRange = vi.fn<ExcelDataConnector['readRange']>(async () => makeResult([['value']]));
    const manager = createWorkingResourceManager((request) => request.sourcePath);
    const tool = createReadRangeTool({ readRange }, manager);

    await tool.execute('source-call', { sheetName: 'Sales', range: 'A1' }, undefined, {
      ...context,
      excelResources: [resourceA],
      excelResourceRefs: [context.excelResourceRefs[0]!],
      activeExcelResourceId: resourceA.id,
    });

    expect(manager.resolveReadablePath).toHaveBeenCalledWith(
      expect.objectContaining({ sourcePath: resourceA.filePath }),
    );
    expect(readRange).toHaveBeenCalledWith(
      { filePath: resourceA.filePath, sheetName: 'Sales', range: 'A1' },
      undefined,
    );
  });

  it('allows exactly 500 requested cells and rejects 510 before resolving or reading', async () => {
    const boundaryValues = Array.from({ length: 50 }, () => Array<ExcelCellValue>(10).fill(null));
    const readRange = vi.fn<ExcelDataConnector['readRange']>(async () =>
      makeResult(boundaryValues, 'A1:J50'),
    );
    const manager = createWorkingResourceManager();
    const tool = createReadRangeTool({ readRange }, manager);

    const output = await tool.execute(
      'boundary-call',
      { sheetName: 'Sales', range: 'A1:J50' },
      undefined,
      {
        ...context,
        excelResources: [resourceA],
        excelResourceRefs: [context.excelResourceRefs[0]!],
      },
    );
    expect(output.details).toMatchObject({
      cellCount: MAX_READ_RANGE_CELLS,
      rowCount: 50,
      columnCount: 10,
    });

    readRange.mockClear();
    manager.resolveReadablePath.mockClear();
    await expect(
      tool.execute('oversized-call', { sheetName: 'Sales', range: 'A1:J51' }, undefined, {
        ...context,
        excelResources: [resourceA],
        excelResourceRefs: [context.excelResourceRefs[0]!],
      }),
    ).rejects.toThrow(
      'read_range range exceeds the 500-cell limit. Request a smaller explicit range or use aggregate_data/filter_data.',
    );
    expect(manager.resolveReadablePath).not.toHaveBeenCalled();
    expect(readRange).not.toHaveBeenCalled();
  });

  it('reports an empty result with zero dimensions and preserves rectangular values', async () => {
    const emptyTool = createReadRangeTool(
      { readRange: async () => makeResult([]) },
      createWorkingResourceManager(),
    );
    const empty = await emptyTool.execute(
      'empty-call',
      { sheetName: 'Sales', range: 'A1' },
      undefined,
      context,
    );
    expect(empty.details).toMatchObject({
      rowCount: 0,
      columnCount: 0,
      cellCount: 0,
      values: [],
    });
    expect(textContent(empty.content)).toContain('values:');

    const irregularTool = createReadRangeTool(
      { readRange: async () => makeResult([['a', 'b'], ['c']]) },
      createWorkingResourceManager(),
    );
    await expect(
      irregularTool.execute(
        'irregular-call',
        { sheetName: 'Sales', range: 'A1:B2' },
        undefined,
        context,
      ),
    ).rejects.toThrow('read_range Gateway result rows must have consistent lengths.');
  });

  it('fails instead of truncating a Gateway result that exceeds the cell limit', async () => {
    const oversizedValues = [Array<ExcelCellValue>(MAX_READ_RANGE_CELLS + 1).fill('value')];
    const tool = createReadRangeTool(
      { readRange: async () => makeResult(oversizedValues, 'A1') },
      createWorkingResourceManager(),
    );

    await expect(
      tool.execute('gateway-oversized', { sheetName: 'Sales', range: 'A1' }, undefined, context),
    ).rejects.toThrow('read_range Gateway result exceeds the 500-cell limit.');
  });

  it('formats complex Excel values and escapes table-breaking string content', async () => {
    const values: readonly ExcelCellValue[] = [
      new Date('2026-09-15T00:00:00.000Z'),
      { formula: 'SUM(A1:A5)', result: 15 },
      { sharedFormula: 'A1+1', formula: 'B1+1', result: 3 },
      { error: '#DIV/0!' },
      { text: 'OpenAI', hyperlink: 'https://example.com' },
      { richText: [{ text: 'Rich ' }, { text: 'text' }] },
      null,
      'line 1\nline 2 | slash \\',
    ];
    const tool = createReadRangeTool(
      { readRange: async () => makeResult([values], 'A1:H1') },
      createWorkingResourceManager(),
    );

    const result = await tool.execute(
      'formatting-call',
      { sheetName: 'Sales', range: 'A1:H1' },
      undefined,
      context,
    );
    const content = textContent(result.content);
    expect(content).toContain('2026-09-15T00:00:00.000Z');
    expect(content).toContain('formula:=SUM(A1:A5), result:15');
    expect(content).toContain('sharedFormula:=A1+1, formula:=B1+1, result:3');
    expect(content).toContain('#DIV/0!');
    expect(content).toContain('OpenAI <https://example.com>');
    expect(content).toContain('Rich text');
    expect(content).toContain('line 1\\nline 2 \\| slash \\\\');
    expect(content).not.toContain('[object Object]');
    expect(result.details?.values[0]).toEqual([
      '2026-09-15T00:00:00.000Z',
      'formula:=SUM(A1:A5), result:15',
      'sharedFormula:=A1+1, formula:=B1+1, result:3',
      '#DIV/0!',
      'OpenAI <https://example.com>',
      'Rich text',
      null,
      'line 1\nline 2 | slash \\',
    ]);
  });

  it('bounds long cell strings in details and model text and counts affected cells', async () => {
    const value = 'x'.repeat(MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH + 100);
    const tool = createReadRangeTool(
      { readRange: async () => makeResult([[value]], 'A1') },
      createWorkingResourceManager(),
    );

    const result = await tool.execute(
      'long-cell-call',
      { sheetName: 'Sales', range: 'A1' },
      undefined,
      context,
    );
    const details = result.details!;
    expect(details.values[0]?.[0]).toHaveLength(MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH);
    expect(details.values[0]?.[0]).toMatch(/\.\.\.\[truncated\]$/);
    expect(details.truncatedCellValueCount).toBe(1);
    expect(textContent(result.content)).toContain('truncatedCellValueCount: 1');
    expect(textContent(result.content)).toContain('...[truncated]');
    expect(textContent(result.content).split('values:\n')[1]).toHaveLength(
      MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH,
    );
  });

  it('limits escaped model text even when the persisted string projection itself fits', async () => {
    const value = '\\'.repeat(MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH / 2 + 100);
    const tool = createReadRangeTool(
      { readRange: async () => makeResult([[value]], 'A1') },
      createWorkingResourceManager(),
    );

    const result = await tool.execute(
      'escaped-cell-call',
      { sheetName: 'Sales', range: 'A1' },
      undefined,
      context,
    );

    expect(result.details?.values[0]?.[0]).toBe(value);
    expect(result.details?.truncatedCellValueCount).toBe(1);
    expect(textContent(result.content).split('values:\n')[1]).toHaveLength(
      MAX_MODEL_VISIBLE_CELL_TEXT_LENGTH,
    );
    expect(textContent(result.content)).toContain('...[truncated]');
  });
});

/** Creates one minimal Gateway result for read_range tests. */
function makeResult(values: readonly (readonly ExcelCellValue[])[], range = 'A1'): ReadRangeResult {
  return { sheetName: 'Sales', range, values };
}

/** Creates a readable-resource resolver fake with an optional path selector. */
function createWorkingResourceManager(
  resolve: (request: {
    readonly sessionId: string;
    readonly sourceResourceId: string;
    readonly sourcePath: string;
    readonly signal?: AbortSignal;
  }) => string = (request) => request.sourcePath,
) {
  return {
    resolveReadablePath: vi.fn(async (request: Parameters<typeof resolve>[0]) => resolve(request)),
  };
}

/** Joins text blocks returned by one Application Tool. */
function textContent(
  content: readonly { readonly type: string; readonly text?: string }[],
): string {
  return content
    .filter((item) => item.type === 'text')
    .map((item) => item.text ?? '')
    .join('\n');
}
