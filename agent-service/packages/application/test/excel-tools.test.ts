import { describe, expect, it, vi } from 'vitest';
import type {
  ExcelDiscoveryConnector,
  GetSheetProfileResult,
  GetWorkbookInfoResult,
} from '@opspilot/tool-gateway';

import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  type ToolContext,
} from '../src/index.js';

const context: ToolContext = {
  sessionId: 'session-1',
  excelResource: { id: 'resource-1', filePath: 'C:/workbooks/report.xlsx' },
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
  sampledRowCount: 5,
  columns: [
    { index: 2, letter: 'B', header: 'Name', inferredType: 'string' },
    { index: 3, letter: 'C', header: 'Count', inferredType: 'number' },
    { index: 4, letter: 'D', header: 'Active', inferredType: 'boolean' },
  ],
};

describe('Excel discovery Application Tools', () => {
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
      properties: {},
      additionalProperties: false,
    });
    expect(tool.parameters).not.toHaveProperty('filePath');

    const result = await tool.execute('call-1', {}, signal, context);

    expect(getWorkbookInfo).toHaveBeenCalledWith(
      { filePath: context.excelResource.filePath },
      signal,
    );
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
        sheetName: { type: 'string', minLength: 1 },
        sampleSize: { type: 'integer', minimum: 1, maximum: 200 },
      },
      required: ['sheetName'],
      additionalProperties: false,
    });
    expect(tool.parameters).not.toHaveProperty('filePath');
    expect(tool.parameters).not.toHaveProperty('fileId');
    expect(tool.parameters).not.toHaveProperty('resourceId');
    expect(tool.parameters).not.toHaveProperty('sessionId');

    const result = await tool.execute(
      'call-2',
      { sheetName: 'Data', sampleSize: 10 },
      signal,
      context,
    );

    expect(getSheetProfile).toHaveBeenCalledWith(
      {
        filePath: context.excelResource.filePath,
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
      'letter: B; header: Name; inferredType: string',
    );
    expect(result.details).toBe(sheetProfile);
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
        filePath: context.excelResource.filePath,
        sheetName: 'Data',
      },
      undefined,
    );
  });
});
