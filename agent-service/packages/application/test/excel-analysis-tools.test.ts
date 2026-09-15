import { describe, expect, it, vi } from 'vitest';
import type { JsonObject } from '@opspilot/model-gateway';
import type {
  AggregateDataResult,
  ExcelAggregateConnector,
  ExcelFilterConnector,
  FilterDataResult,
} from '@opspilot/tool-gateway';

import {
  createAggregateDataTool,
  createFilterDataTool,
  type ExcelWorkingResourceRequest,
  type ToolContext,
} from '../src/index.js';

const resourceA = { id: 'resource-a', filePath: '/source/a.xlsx' };
const resourceB = { id: 'resource-b', filePath: '/source/b.xlsx' };
const context: ToolContext = {
  turnId: 'turn-analysis',
  sessionId: 'session-analysis',
  excelResources: [resourceA, resourceB],
  excelResourceRefs: [
    { id: resourceA.id, kind: 'excel', alias: 'excel-1' },
    { id: resourceB.id, kind: 'excel', alias: 'excel-2' },
  ],
  activeExcelResourceId: resourceB.id,
};

const aggregateResult: AggregateDataResult = {
  sheetName: 'Sales',
  columns: [
    { name: 'Region', kind: 'group', sourceColumn: 'Region' },
    { name: 'totalSales', kind: 'metric', sourceColumn: 'Sales', operation: 'sum' },
  ],
  rows: [['North', 400]],
  sourceRowCount: 3,
  resultRowCount: 1,
};

const filterResult: FilterDataResult = {
  sheetName: 'Sales',
  sourceRowCount: 3,
  matchedRowCount: 2,
  matchedRanges: [
    { startRow: 2, endRow: 2 },
    { startRow: 4, endRow: 4 },
  ],
};

describe('aggregate_data Application Tool', () => {
  it('routes aliases to the selected readable resource and forwards aggregate options', async () => {
    const signal = new AbortController().signal;
    const aggregateData = vi.fn<ExcelAggregateConnector['aggregateData']>(
      async () => aggregateResult,
    );
    const workingResourceManager = createWorkingResourceManager((request) =>
      request.sourceResourceId === resourceA.id ? '/working/a/revision-2.xlsx' : request.sourcePath,
    );
    const tool = createAggregateDataTool({ aggregateData }, workingResourceManager);

    const result = await tool.execute(
      'aggregate-call',
      {
        resource: 'excel-1',
        sheetName: 'Sales',
        range: 'A1:C4',
        where: {
          conditions: [{ column: 'Status', operator: 'equals', value: 'Closed' }],
          logic: 'any',
        },
        groupBy: ['Region'],
        metrics: [
          { column: 'Sales', operation: 'sum', alias: 'totalSales' },
          { column: 'Sales', operation: 'count' },
          { column: 'Sales', operation: 'average' },
          { column: 'Sales', operation: 'min' },
          { column: 'Sales', operation: 'max' },
        ],
      },
      signal,
      context,
    );

    expect(workingResourceManager.resolveReadablePath).toHaveBeenCalledWith({
      sessionId: context.sessionId,
      sourceResourceId: resourceA.id,
      sourcePath: resourceA.filePath,
      signal,
    });
    expect(aggregateData).toHaveBeenCalledWith(
      {
        filePath: '/working/a/revision-2.xlsx',
        sheetName: 'Sales',
        range: 'A1:C4',
        where: {
          conditions: [{ column: 'Status', operator: 'equals', value: 'Closed' }],
          logic: 'any',
        },
        groupBy: ['Region'],
        metrics: [
          { column: 'Sales', operation: 'sum', alias: 'totalSales' },
          { column: 'Sales', operation: 'count' },
          { column: 'Sales', operation: 'average' },
          { column: 'Sales', operation: 'min' },
          { column: 'Sales', operation: 'max' },
        ],
      },
      signal,
    );
    expect(tool.recoveryPolicy).toBe('retry_safe');
    expect(result.details).toEqual(aggregateResult);
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('North | 400');
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'resultRowCount: 1',
    );
  });

  it('bounds rows in model text and persisted details while retaining the total count', async () => {
    const resultData: AggregateDataResult = {
      ...aggregateResult,
      rows: Array.from({ length: 101 }, (_, index) => [`Region-${index + 1}`, index + 1]),
      resultRowCount: 101,
    };
    const tool = createAggregateDataTool(
      { aggregateData: async () => resultData },
      createWorkingResourceManager(),
    );

    const result = await tool.execute(
      'large-aggregate-call',
      { sheetName: 'Sales', metrics: [{ column: 'Sales', operation: 'sum' }] },
      undefined,
      singleResourceContext(),
    );
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('resultRowCount: 101');
    expect(text).toContain('Region-100 | 100');
    expect(text).not.toContain('Region-101');
    expect(text).toContain('Showing first 100 of 101 aggregate rows.');
    expect(result.details).toMatchObject({ resultRowCount: 101, rows: expect.any(Array) });
    expect(result.details?.rows).toHaveLength(100);
  });

  it('rejects invalid predicates and metrics before calling the connector', async () => {
    const aggregateData = vi.fn<ExcelAggregateConnector['aggregateData']>(
      async () => aggregateResult,
    );
    const tool = createAggregateDataTool({ aggregateData }, createWorkingResourceManager());

    for (const where of [
      { conditions: [{ column: 'Sales', operator: 'greaterThan' }] },
      { conditions: [{ column: 'Sales', operator: 'isEmpty', value: null }] },
      { conditions: [{ column: 'Sales', operator: 'equals', value: Number.POSITIVE_INFINITY }] },
      { conditions: [{ column: 'Sales', operator: 'equals', value: 'x' }], logic: 'xor' },
    ]) {
      await expect(
        tool.execute(
          'invalid-aggregate-call',
          {
            sheetName: 'Sales',
            where,
            metrics: [{ column: 'Sales', operation: 'sum' }],
          } as unknown as JsonObject,
          undefined,
          singleResourceContext(),
        ),
      ).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      tool.execute(
        'invalid-metric-call',
        { sheetName: 'Sales', metrics: [] },
        undefined,
        singleResourceContext(),
      ),
    ).rejects.toBeInstanceOf(TypeError);

    expect(aggregateData).not.toHaveBeenCalled();
  });

  it('formats Date and null group values safely and omits absent options', async () => {
    const date = new Date('2026-09-15T00:00:00.000Z');
    const resultData: AggregateDataResult = {
      ...aggregateResult,
      columns: [{ name: 'OrderDate', kind: 'group', sourceColumn: 'OrderDate' }],
      rows: [[date], [null]],
      resultRowCount: 2,
    };
    const aggregateData = vi.fn<ExcelAggregateConnector['aggregateData']>(async () => resultData);
    const tool = createAggregateDataTool({ aggregateData }, createWorkingResourceManager());
    const result = await tool.execute(
      'date-aggregate-call',
      { sheetName: 'Sales', metrics: [{ column: 'Sales', operation: 'sum' }] },
      undefined,
      singleResourceContext(),
    );

    expect(aggregateData).toHaveBeenCalledWith(
      {
        filePath: resourceA.filePath,
        sheetName: 'Sales',
        metrics: [{ column: 'Sales', operation: 'sum' }],
      },
      undefined,
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      date.toISOString(),
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('\nnull');
    expect(JSON.stringify(result)).not.toContain('[object Object]');
  });
});

describe('filter_data Application Tool', () => {
  it('uses the selected readable resource and returns only matching row ranges', async () => {
    const signal = new AbortController().signal;
    const filterData = vi.fn<ExcelFilterConnector['filterData']>(async () => filterResult);
    const workingResourceManager = createWorkingResourceManager((request) =>
      request.sourceResourceId === resourceA.id ? '/working/a/revision-3.xlsx' : request.sourcePath,
    );
    const tool = createFilterDataTool({ filterData }, workingResourceManager);
    const result = await tool.execute(
      'filter-call',
      {
        resource: 'excel-1',
        sheetName: 'Sales',
        range: 'A1:C4',
        conditions: [
          { column: 'Region', operator: 'equals', value: 'North' },
          { column: 'Sales', operator: 'greaterThan', value: 100 },
        ],
        logic: 'all',
      },
      signal,
      context,
    );

    expect(workingResourceManager.resolveReadablePath).toHaveBeenCalledWith({
      sessionId: context.sessionId,
      sourceResourceId: resourceA.id,
      sourcePath: resourceA.filePath,
      signal,
    });
    expect(filterData).toHaveBeenCalledWith(
      {
        filePath: '/working/a/revision-3.xlsx',
        sheetName: 'Sales',
        range: 'A1:C4',
        conditions: [
          { column: 'Region', operator: 'equals', value: 'North' },
          { column: 'Sales', operator: 'greaterThan', value: 100 },
        ],
        logic: 'all',
      },
      signal,
    );
    expect(result.details).toEqual(filterResult);
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'matchedRowCount: 2',
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('2-2\n4-4');
    expect(JSON.stringify(result.details)).not.toContain('Region');
    expect(createFilterDataTool({ filterData }, workingResourceManager).recoveryPolicy).toBe(
      'retry_safe',
    );
  });

  it('supports any logic and empty operators without value', async () => {
    const filterData = vi.fn<ExcelFilterConnector['filterData']>(async () => filterResult);
    const tool = createFilterDataTool({ filterData }, createWorkingResourceManager());

    await tool.execute(
      'empty-predicate-call',
      {
        sheetName: 'Sales',
        conditions: [
          { column: 'Region', operator: 'isEmpty' },
          { column: 'Product', operator: 'isNotEmpty' },
        ],
        logic: 'any',
      },
      undefined,
      singleResourceContext(),
    );

    expect(filterData).toHaveBeenCalledWith(
      {
        filePath: resourceA.filePath,
        sheetName: 'Sales',
        conditions: [
          { column: 'Region', operator: 'isEmpty' },
          { column: 'Product', operator: 'isNotEmpty' },
        ],
        logic: 'any',
      },
      undefined,
    );
  });

  it('rejects invalid predicates before calling the connector', async () => {
    const filterData = vi.fn<ExcelFilterConnector['filterData']>(async () => filterResult);
    const tool = createFilterDataTool({ filterData }, createWorkingResourceManager());

    for (const conditions of [
      [{ column: 'Sales', operator: 'greaterThan' }],
      [{ column: 'Region', operator: 'isEmpty', value: 'North' }],
      [{ column: '', operator: 'equals', value: 'North' }],
      [{ column: 'Region', operator: 'equals', value: new Date() }],
    ]) {
      await expect(
        tool.execute(
          'invalid-filter-call',
          { sheetName: 'Sales', conditions } as unknown as JsonObject,
          undefined,
          singleResourceContext(),
        ),
      ).rejects.toBeInstanceOf(TypeError);
    }
    await expect(
      tool.execute(
        'invalid-filter-logic-call',
        {
          sheetName: 'Sales',
          conditions: [{ column: 'Region', operator: 'equals', value: 'North' }],
          logic: 'xor',
        } as unknown as JsonObject,
        undefined,
        singleResourceContext(),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(filterData).not.toHaveBeenCalled();
  });

  it('bounds displayed and persisted ranges while retaining the matched row count', async () => {
    const resultData: FilterDataResult = {
      ...filterResult,
      matchedRowCount: 150,
      matchedRanges: Array.from({ length: 150 }, (_, index) => ({
        startRow: index * 2 + 2,
        endRow: index * 2 + 2,
      })),
    };
    const tool = createFilterDataTool(
      { filterData: async () => resultData },
      createWorkingResourceManager(),
    );
    const result = await tool.execute(
      'large-filter-call',
      { sheetName: 'Sales', conditions: [{ column: 'Region', operator: 'isNotEmpty' }] },
      undefined,
      singleResourceContext(),
    );
    const text = result.content[0]?.type === 'text' ? result.content[0].text : '';

    expect(text).toContain('matchedRowCount: 150');
    expect(text).toContain('200-200');
    expect(text).not.toContain('202-202');
    expect(text).toContain('Showing first 100 of 150 matched ranges.');
    expect(result.details?.matchedRowCount).toBe(150);
    expect(result.details?.matchedRanges).toHaveLength(100);
  });
});

function createWorkingResourceManager(
  resolvePath: (request: ExcelWorkingResourceRequest) => string = (request) => request.sourcePath,
) {
  return {
    resolveReadablePath: vi.fn(async (request: ExcelWorkingResourceRequest) =>
      resolvePath(request),
    ),
  };
}

function singleResourceContext(): ToolContext {
  return {
    ...context,
    excelResources: [resourceA],
    excelResourceRefs: [context.excelResourceRefs[0]!],
    activeExcelResourceId: resourceA.id,
  };
}
