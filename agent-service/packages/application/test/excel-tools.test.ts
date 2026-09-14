import { describe, expect, it, vi } from 'vitest';
import { AgentToolExecutionError } from '@opspilot/agent-runtime';
import type {
  ExcelDiscoveryConnector,
  GetSheetProfileResult,
  GetWorkbookInfoResult,
} from '@opspilot/tool-gateway';

import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  requireExcelResource,
  resolveExcelResource,
  type ToolContext,
} from '../src/index.js';

const excelResource = { id: 'resource-1', filePath: 'C:/workbooks/report.xlsx' };
const context: ToolContext = {
  sessionId: 'session-1',
  excelResources: [excelResource],
  activeExcelResourceId: excelResource.id,
};

const contextWithoutResource: ToolContext = {
  sessionId: 'session-1',
  excelResources: [],
  activeExcelResourceId: null,
};

const resourceA = { id: 'resource-a', filePath: 'C:/workbooks/a.xlsx' };
const resourceB = { id: 'resource-b', filePath: 'C:/workbooks/b.xlsx' };
const multiResourceContext: ToolContext = {
  sessionId: 'session-1',
  excelResources: [resourceA, resourceB],
  activeExcelResourceId: resourceB.id,
};

const workbookInfo: GetWorkbookInfoResult = {
  sheetCount: 2,
  activeSheetName: 'Data',
  sheets: [
    {
      name: 'Summary',
      index: 1,
      state: 'visible',
      usedRange: 'A1:C4',
      rowCount: 4,
      columnCount: 3,
    },
    {
      name: 'Data',
      index: 2,
      state: 'hidden',
      usedRange: null,
      rowCount: 0,
      columnCount: 0,
    },
  ],
};

const sheetProfile: GetSheetProfileResult = {
  sheetName: 'Data',
  usedRange: 'B3:D8',
  rowCount: 6,
  columnCount: 3,
  headerRow: 3,
  headerConfidence: 0.91,
  sampledRowCount: 5,
  columns: [
    { index: 2, letter: 'B', header: 'Name', inferredType: 'string' },
    { index: 3, letter: 'C', header: 'Count', inferredType: 'number' },
    { index: 4, letter: 'D', header: 'Active', inferredType: 'boolean' },
  ],
};

describe('Excel discovery Application Tools', () => {
  it('resolves the only Excel resource when no resourceId is provided', () => {
    expect(resolveExcelResource(context)).toBe(excelResource);
    expect(requireExcelResource(context)).toBe(excelResource);
  });

  it('resolves an explicitly selected resource instead of the active resource', () => {
    expect(resolveExcelResource(multiResourceContext, resourceA.id)).toBe(resourceA);
  });

  it('uses the active resource as the default when multiple resources are available', () => {
    expect(resolveExcelResource(multiResourceContext)).toBe(resourceB);
  });

  it('returns recoverable errors for invalid resource selection states', () => {
    expect(() => resolveExcelResource(multiResourceContext, 'missing')).toThrowError(
      expect.objectContaining({
        code: 'EXCEL_RESOURCE_NOT_FOUND',
        message: 'Excel resource "missing" is not available in this Turn.',
      }),
    );
    expect(() =>
      resolveExcelResource({
        ...multiResourceContext,
        activeExcelResourceId: null,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: 'EXCEL_RESOURCE_SELECTION_REQUIRED',
        message: 'Multiple Excel resources are available. Specify resourceId.',
      }),
    );
  });

  it('throws a recoverable error with a stable code when no resource is present', () => {
    let error: unknown;
    try {
      requireExcelResource(contextWithoutResource);
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AgentToolExecutionError);
    expect(error).toMatchObject({ code: 'EXCEL_RESOURCE_REQUIRED' });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('No Excel workbook is attached');
  });

  it('exposes workbook metadata without filePath and preserves connector result', async () => {
    const signal = new AbortController().signal;
    const getWorkbookInfo = vi.fn(async () => workbookInfo);
    const connector: ExcelDiscoveryConnector = {
      getWorkbookInfo,
      getSheetProfile: vi.fn(),
    };
    const tool = createGetWorkbookInfoTool(connector);

    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          minLength: 1,
          description:
            'ID of the Excel resource to operate on. Use one of the resource IDs available in the current Session.',
        },
      },
      additionalProperties: false,
    });
    expect(tool.parameters).not.toHaveProperty('filePath');

    const result = await tool.execute('call-1', {}, signal, context);

    expect(getWorkbookInfo).toHaveBeenCalledWith({ filePath: excelResource.filePath }, signal);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('sheetCount: 2');
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('name: Summary');
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('state: hidden');
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'usedRange: A1:C4',
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('rowCount: 4');
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'columnCount: 3',
    );
    expect(result.details).toBe(workbookInfo);
  });

  it('combines sheet arguments with the resource filePath and preserves profile result', async () => {
    const signal = new AbortController().signal;
    const getSheetProfile = vi.fn(async () => sheetProfile);
    const connector: ExcelDiscoveryConnector = {
      getWorkbookInfo: vi.fn(),
      getSheetProfile,
    };
    const tool = createGetSheetProfileTool(connector);

    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        resourceId: {
          type: 'string',
          minLength: 1,
          description:
            'ID of the Excel resource to operate on. Use one of the resource IDs available in the current Session.',
        },
        sheetName: { type: 'string', minLength: 1 },
        sampleSize: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['sheetName'],
      additionalProperties: false,
    });
    expect(tool.parameters).not.toHaveProperty('filePath');
    expect(tool.parameters).not.toHaveProperty('fileId');
    expect(tool.parameters).not.toHaveProperty('sessionId');

    const result = await tool.execute(
      'call-2',
      { sheetName: 'Data', sampleSize: 10 },
      signal,
      context,
    );

    expect(getSheetProfile).toHaveBeenCalledWith(
      {
        filePath: excelResource.filePath,
        sheetName: 'Data',
        sampleSize: 10,
      },
      signal,
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'sheetName: Data',
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'usedRange: B3:D8',
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain('headerRow: 3');
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'headerConfidence: 0.91',
    );
    expect(result.content[0]?.type === 'text' && result.content[0].text).toContain(
      'letter: B; header: Name; inferredType: string',
    );
    expect(result.details).toBe(sheetProfile);
  });

  it('passes the explicitly selected resource filePath to the workbook capability', async () => {
    const getWorkbookInfo = vi.fn(async () => workbookInfo);
    const connector: ExcelDiscoveryConnector = {
      getWorkbookInfo,
      getSheetProfile: vi.fn(),
    };

    await createGetWorkbookInfoTool(connector).execute(
      'call-resource-id',
      { resourceId: resourceA.id },
      undefined,
      multiResourceContext,
    );

    expect(getWorkbookInfo).toHaveBeenCalledWith({ filePath: resourceA.filePath }, undefined);
  });

  it('omits sampleSize when the model does not provide it', async () => {
    const getSheetProfile = vi.fn(async () => sheetProfile);
    const connector: ExcelDiscoveryConnector = {
      getWorkbookInfo: vi.fn(),
      getSheetProfile,
    };

    await createGetSheetProfileTool(connector).execute(
      'call-3',
      { sheetName: 'Data' },
      undefined,
      context,
    );

    expect(getSheetProfile).toHaveBeenCalledWith(
      {
        filePath: excelResource.filePath,
        sheetName: 'Data',
      },
      undefined,
    );
  });

  it('fails both Excel tools without a resource and does not call the connector', async () => {
    const getWorkbookInfo = vi.fn(async () => workbookInfo);
    const getSheetProfile = vi.fn(async () => sheetProfile);
    const connector: ExcelDiscoveryConnector = { getWorkbookInfo, getSheetProfile };

    await expect(
      createGetWorkbookInfoTool(connector).execute('call-4', {}, undefined, contextWithoutResource),
    ).rejects.toMatchObject({
      code: 'EXCEL_RESOURCE_REQUIRED',
      message: expect.stringContaining('No Excel workbook is attached'),
    });
    await expect(
      createGetSheetProfileTool(connector).execute(
        'call-5',
        { sheetName: 'Data' },
        undefined,
        contextWithoutResource,
      ),
    ).rejects.toMatchObject({
      code: 'EXCEL_RESOURCE_REQUIRED',
      message: expect.stringContaining('No Excel workbook is attached'),
    });

    expect(getWorkbookInfo).not.toHaveBeenCalled();
    expect(getSheetProfile).not.toHaveBeenCalled();
  });
});
