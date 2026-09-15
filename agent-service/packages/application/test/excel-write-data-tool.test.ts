import { describe, expect, it, vi } from 'vitest';
import type { ExcelDataConnector, WriteDataResult } from '@opspilot/tool-gateway';

import {
  createWriteDataTool,
  type ExcelWorkingResource,
  type ExcelWorkingResourceManager,
  type ExcelWorkingResourceRequest,
  type ToolContext,
} from '../src/index.js';

const resourceA = { id: 'resource-a', filePath: '/source/a.xlsx' };
const resourceB = { id: 'resource-b', filePath: '/source/b.xlsx' };
const multiResourceContext: ToolContext = {
  sessionId: 'session-1',
  excelResources: [resourceA, resourceB],
  excelResourceRefs: [
    { id: resourceA.id, kind: 'excel', alias: 'excel-1' },
    { id: resourceB.id, kind: 'excel', alias: 'excel-2' },
  ],
  activeExcelResourceId: resourceB.id,
};

const writeResult: WriteDataResult = {
  sheetName: 'Sales',
  range: 'C2:D3',
  message: 'Data written to Sales',
};

describe('write_data Application Tool', () => {
  it('writes the selected resource working path and advances revision only after success', async () => {
    const order: string[] = [];
    const { manager, ensureWritableResource, markModified } = createManager(order);
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => {
      order.push('writeData');
      return writeResult;
    });
    const tool = createWriteDataTool(createConnector(writeData), manager);
    const signal = new AbortController().signal;

    const result = await tool.execute(
      'write-call',
      {
        resource: 'excel-1',
        sheetName: 'Sales',
        startCell: 'C2',
        data: [
          ['North', true],
          [null, 42],
        ],
      },
      signal,
      multiResourceContext,
    );

    const request: ExcelWorkingResourceRequest = {
      sessionId: multiResourceContext.sessionId,
      sourceResourceId: resourceA.id,
      sourcePath: resourceA.filePath,
      signal,
    };
    expect(order).toEqual(['ensureWritableResource', 'writeData', 'markModified']);
    expect(ensureWritableResource).toHaveBeenCalledWith(request);
    expect(writeData).toHaveBeenCalledWith(
      {
        filePath: '/workspace/session-1/resource-a/working.xlsx',
        sheetName: 'Sales',
        startCell: 'C2',
        data: [
          ['North', true],
          [null, 42],
        ],
      },
      signal,
    );
    expect(markModified).toHaveBeenCalledWith(request);
    expect(tool.recoveryPolicy).toBe('manual');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        resource: expect.any(Object),
        sheetName: expect.any(Object),
        startCell: expect.any(Object),
        data: expect.objectContaining({
          type: 'array',
          minItems: 1,
          items: expect.objectContaining({
            type: 'array',
            minItems: 1,
            items: expect.any(Object),
          }),
        }),
      },
      required: ['data'],
      additionalProperties: false,
    });
    expect(tool.parameters).not.toHaveProperty('filePath');
    expect(tool.parameters).not.toHaveProperty('sourcePath');
    expect(tool.parameters).not.toHaveProperty('workingPath');
    expect(result.details).toBe(writeResult);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'sheetName: Sales\nrange: C2:D3\nmessage: Data written to Sales',
    });
    expect(result.content[0]?.text).not.toContain('/workspace/');
  });

  it('omits optional Gateway fields when the model does not provide them', async () => {
    const { manager } = createManager([]);
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => writeResult);
    const tool = createWriteDataTool(createConnector(writeData), manager);

    await tool.execute('write-call', { data: [['value']] }, undefined, {
      ...multiResourceContext,
      excelResources: [resourceA],
      excelResourceRefs: [multiResourceContext.excelResourceRefs[0]!],
      activeExcelResourceId: resourceA.id,
    });

    expect(writeData).toHaveBeenCalledWith(
      {
        filePath: '/workspace/session-1/resource-a/working.xlsx',
        data: [['value']],
      },
      undefined,
    );
  });

  it('does not mark the resource modified when Gateway mutation fails', async () => {
    const order: string[] = [];
    const { manager, markModified } = createManager(order);
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => {
      order.push('writeData');
      throw new Error('Excel write failed.');
    });
    const tool = createWriteDataTool(createConnector(writeData), manager);

    await expect(
      tool.execute('write-call', { data: [['value']] }, undefined, {
        ...multiResourceContext,
        excelResources: [resourceA],
        excelResourceRefs: [multiResourceContext.excelResourceRefs[0]!],
        activeExcelResourceId: resourceA.id,
      }),
    ).rejects.toThrow('Excel write failed.');

    expect(order).toEqual(['ensureWritableResource', 'writeData']);
    expect(markModified).not.toHaveBeenCalled();
  });

  it('does not mark the resource modified when cancellation arrives during Gateway execution', async () => {
    const order: string[] = [];
    const { manager, markModified } = createManager(order);
    const controller = new AbortController();
    const abortReason = new Error('Write was cancelled.');
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => {
      order.push('writeData');
      controller.abort(abortReason);
      return writeResult;
    });
    const tool = createWriteDataTool(createConnector(writeData), manager);

    await expect(
      tool.execute('write-call', { data: [['value']] }, controller.signal, {
        ...multiResourceContext,
        excelResources: [resourceA],
        excelResourceRefs: [multiResourceContext.excelResourceRefs[0]!],
        activeExcelResourceId: resourceA.id,
      }),
    ).rejects.toBe(abortReason);

    expect(order).toEqual(['ensureWritableResource', 'writeData']);
    expect(markModified).not.toHaveBeenCalled();
  });

  it('rejects empty, jagged, and non-scalar matrices before creating a working copy', async () => {
    const order: string[] = [];
    const { manager, ensureWritableResource } = createManager(order);
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => writeResult);
    const tool = createWriteDataTool(createConnector(writeData), manager);
    const context: ToolContext = {
      ...multiResourceContext,
      excelResources: [resourceA],
      excelResourceRefs: [multiResourceContext.excelResourceRefs[0]!],
      activeExcelResourceId: resourceA.id,
    };

    for (const data of [[], [[]], [[1], [2, 3]], [[{ formula: 'A1+1' }]], [[Number.NaN]]]) {
      await expect(
        tool.execute('invalid-write-call', { data }, undefined, context),
      ).rejects.toBeInstanceOf(TypeError);
    }

    expect(ensureWritableResource).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });
});

function createManager(order: string[]): {
  readonly manager: Pick<ExcelWorkingResourceManager, 'ensureWritableResource' | 'markModified'>;
  readonly ensureWritableResource: ReturnType<
    typeof vi.fn<ExcelWorkingResourceManager['ensureWritableResource']>
  >;
  readonly markModified: ReturnType<typeof vi.fn<ExcelWorkingResourceManager['markModified']>>;
} {
  const ensureWritableResource = vi.fn<ExcelWorkingResourceManager['ensureWritableResource']>(
    async (request) => {
      order.push('ensureWritableResource');
      return workingResource(request);
    },
  );
  const markModified = vi.fn<ExcelWorkingResourceManager['markModified']>(async (request) => {
    order.push('markModified');
    return { ...workingResource(request), revision: 1 };
  });
  return {
    manager: { ensureWritableResource, markModified },
    ensureWritableResource,
    markModified,
  };
}

function createConnector(writeData: ExcelDataConnector['writeData']): ExcelDataConnector {
  return {
    readRange: async () => {
      throw new Error('readRange is not used by this test.');
    },
    writeData,
    readRangeWithMetadata: async () => {
      throw new Error('readRangeWithMetadata is not used by this test.');
    },
  };
}

function workingResource(request: ExcelWorkingResourceRequest): ExcelWorkingResource {
  return {
    sessionId: request.sessionId,
    sourceResourceId: request.sourceResourceId,
    sourcePath: request.sourcePath,
    workingPath: `/workspace/${request.sessionId}/${request.sourceResourceId}/working.xlsx`,
    revision: 0,
  };
}
