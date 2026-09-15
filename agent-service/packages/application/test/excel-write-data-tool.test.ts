import { describe, expect, it, vi } from 'vitest';
import type { ExcelDataConnector, WriteDataResult } from '@opspilot/tool-gateway';

import {
  createWriteDataTool,
  type ExcelWorkingMutationContext,
  type ExcelWorkingMutationRequest,
  type ExcelWorkingResourceManager,
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
  it('uses callId as mutationId and writes only to the selected resource staging path', async () => {
    const order: string[] = [];
    const { manager, executeMutation } = createManager(order);
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

    const request: ExcelWorkingMutationRequest = {
      sessionId: multiResourceContext.sessionId,
      sourceResourceId: resourceA.id,
      sourcePath: resourceA.filePath,
      signal,
      mutationId: 'write-call',
    };
    expect(order).toEqual(['executeMutation', 'writeData', 'commit']);
    expect(executeMutation).toHaveBeenCalledWith(request, expect.any(Function));
    expect(writeData).toHaveBeenCalledWith(
      {
        filePath: '/workspace/session-1/resource-a/staging/mutation.xlsx',
        sheetName: 'Sales',
        startCell: 'C2',
        data: [
          ['North', true],
          [null, 42],
        ],
      },
      signal,
    );
    expect(tool.recoveryPolicy).toBe('retry_safe');
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
    expect(result.details).toEqual(writeResult);
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
        filePath: '/workspace/session-1/resource-a/staging/mutation.xlsx',
        data: [['value']],
      },
      undefined,
    );
  });

  it('does not return success when Gateway mutation fails', async () => {
    const order: string[] = [];
    const { manager } = createManager(order);
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => {
      order.push('writeData');
      throw new Error('Excel write failed.');
    });
    const tool = createWriteDataTool(createConnector(writeData), manager);

    await expect(
      tool.execute('write-call', { data: [['value']] }, undefined, singleResourceContext()),
    ).rejects.toThrow('Excel write failed.');

    expect(order).toEqual(['executeMutation', 'writeData']);
  });

  it('fails closed when a persisted replay receipt does not match WriteDataResult', async () => {
    const { manager } = createManager([], { invalidReceipt: true });
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => writeResult);
    const tool = createWriteDataTool(createConnector(writeData), manager);

    await expect(
      tool.execute('write-call', { data: [['value']] }, undefined, singleResourceContext()),
    ).rejects.toThrow('Persisted write_data receipt is invalid.');
    expect(writeData).not.toHaveBeenCalled();
  });

  it('rejects empty, jagged, and non-scalar matrices before starting a mutation', async () => {
    const order: string[] = [];
    const { manager, executeMutation } = createManager(order);
    const writeData = vi.fn<ExcelDataConnector['writeData']>(async () => writeResult);
    const tool = createWriteDataTool(createConnector(writeData), manager);

    for (const data of [[], [[]], [[1], [2, 3]], [[{ formula: 'A1+1' }]], [[Number.NaN]]]) {
      await expect(
        tool.execute('invalid-write-call', { data }, undefined, singleResourceContext()),
      ).rejects.toBeInstanceOf(TypeError);
    }

    expect(executeMutation).not.toHaveBeenCalled();
    expect(writeData).not.toHaveBeenCalled();
    expect(order).toEqual([]);
  });
});

function createManager(
  order: string[],
  options: { readonly invalidReceipt?: boolean } = {},
): {
  readonly manager: Pick<ExcelWorkingResourceManager, 'executeMutation'>;
  readonly executeMutation: ReturnType<
    typeof vi.fn<ExcelWorkingResourceManager['executeMutation']>
  >;
} {
  const executeMutation = vi.fn<ExcelWorkingResourceManager['executeMutation']>(
    async (request, mutate) => {
      order.push('executeMutation');
      const context: ExcelWorkingMutationContext = {
        stagingPath: '/workspace/session-1/resource-a/staging/mutation.xlsx',
        baseRevision: 0,
        targetRevision: 1,
      };
      const receipt = options.invalidReceipt
        ? { sheetName: 1, range: 'C2:D3', message: 'bad' }
        : await mutate(context);
      if (!options.invalidReceipt) order.push('commit');
      return {
        resource: {
          sessionId: request.sessionId,
          sourceResourceId: request.sourceResourceId,
          sourcePath: request.sourcePath,
          workingPath: '/workspace/session-1/resource-a/revisions/revision-1.xlsx',
          revision: 1,
        },
        receipt,
        replayed: options.invalidReceipt === true,
      };
    },
  );
  return { manager: { executeMutation }, executeMutation };
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

function singleResourceContext(): ToolContext {
  return {
    ...multiResourceContext,
    excelResources: [resourceA],
    excelResourceRefs: [multiResourceContext.excelResourceRefs[0]!],
    activeExcelResourceId: resourceA.id,
  };
}
