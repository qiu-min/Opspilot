import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workbook } from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ExcelCapabilityErrorCode,
  ExcelJsDiscoveryAdapter,
  getSheetProfileInputSchema,
} from '../../../src/index.js';

describe('ExcelJsDiscoveryAdapter', () => {
  let directory: string;
  let filePath: string;
  let adapter: ExcelJsDiscoveryAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-discovery-'));
    filePath = join(directory, 'workbook.xlsx');
    adapter = new ExcelJsDiscoveryAdapter();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('getWorkbookInfo', () => {
    it('summarizes every worksheet, active sheet, state, and value-based used range', async () => {
      await createWorkbook(filePath, (workbook) => {
        const profile = workbook.addWorksheet('Profile');
        profile.getCell('B3').value = 'Name';
        profile.getCell('J5').value = 'value';

        const active = workbook.addWorksheet('Active');
        active.getCell('A1').value = 'active';

        const hidden = workbook.addWorksheet('Hidden');
        hidden.state = 'hidden';
        hidden.getCell('C2').value = 'hidden value';

        const veryHidden = workbook.addWorksheet('VeryHidden');
        veryHidden.state = 'veryHidden';
        veryHidden.getCell('D4').value = 'very hidden value';

        workbook.addWorksheet('Empty');

        const metadata = workbook.addWorksheet('Metadata');
        metadata.getCell('A50000').dataValidation = {
          type: 'list',
          formulae: ['"Yes,No"'],
        };
        metadata.getCell('B40000').font = { bold: true };
        workbook.views = [
          {
            x: 0,
            y: 0,
            width: 12000,
            height: 8000,
            firstSheet: 0,
            activeTab: 1,
            visibility: 'visible',
          },
        ];
      });

      const result = await adapter.getWorkbookInfo({ filePath });

      expect(result).toEqual({
        sheetCount: 6,
        activeSheetName: 'Active',
        sheets: [
          {
            name: 'Profile',
            index: 1,
            state: 'visible',
            usedRange: 'B3:J5',
            rowCount: 3,
            columnCount: 9,
          },
          {
            name: 'Active',
            index: 2,
            state: 'visible',
            usedRange: 'A1:A1',
            rowCount: 1,
            columnCount: 1,
          },
          {
            name: 'Hidden',
            index: 3,
            state: 'hidden',
            usedRange: 'C2:C2',
            rowCount: 1,
            columnCount: 1,
          },
          {
            name: 'VeryHidden',
            index: 4,
            state: 'veryHidden',
            usedRange: 'D4:D4',
            rowCount: 1,
            columnCount: 1,
          },
          {
            name: 'Empty',
            index: 5,
            state: 'visible',
            usedRange: null,
            rowCount: 0,
            columnCount: 0,
          },
          {
            name: 'Metadata',
            index: 6,
            state: 'visible',
            usedRange: null,
            rowCount: 0,
            columnCount: 0,
          },
        ],
      });
    });

    it('maps workbook open failures to the shared capability error model', async () => {
      await expect(
        adapter.getWorkbookInfo({ filePath: join(directory, 'missing.xlsx') }),
      ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.WORKBOOK_OPEN_FAILED });
    });

    it('honors an already-aborted signal', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });
      const controller = new AbortController();
      controller.abort('cancelled by caller');

      await expect(adapter.getWorkbookInfo({ filePath }, controller.signal)).rejects.toMatchObject({
        code: ExcelCapabilityErrorCode.EXCEL_OPERATION_FAILED,
        message: "Excel operation 'getWorkbookInfo' was cancelled",
      });
    });
  });

  describe('getSheetProfile', () => {
    it('finds the header row and infers types without returning source rows', async () => {
      await createProfileWorkbook(filePath);

      const result = await adapter.getSheetProfile({
        filePath,
        sheetName: 'Profile',
      });

      expect(result).toEqual({
        sheetName: 'Profile',
        usedRange: 'B3:J5',
        rowCount: 3,
        columnCount: 9,
        headerRow: 3,
        sampledRowCount: 2,
        columns: [
          { index: 2, letter: 'B', header: 'Name', inferredType: 'string' },
          { index: 3, letter: 'C', header: 'Count', inferredType: 'number' },
          { index: 4, letter: 'D', header: 'Active', inferredType: 'boolean' },
          { index: 5, letter: 'E', header: 'Date', inferredType: 'date' },
          { index: 6, letter: 'F', header: 'Formula', inferredType: 'formula' },
          { index: 7, letter: 'G', header: null, inferredType: 'mixed' },
          { index: 8, letter: 'H', header: 'Name', inferredType: 'mixed' },
          { index: 9, letter: 'I', header: 'Empty', inferredType: 'empty' },
          { index: 10, letter: 'J', header: 'Error', inferredType: 'error' },
        ],
      });
      expect(result).not.toHaveProperty('rows');
      expect(result).not.toHaveProperty('values');
    });

    it('limits type samples while keeping used range independent from sample size', async () => {
      await createProfileWorkbook(filePath);

      const result = await adapter.getSheetProfile({
        filePath,
        sheetName: 'Profile',
        sampleSize: 1,
      });

      expect(result.usedRange).toBe('B3:J5');
      expect(result.rowCount).toBe(3);
      expect(result.columnCount).toBe(9);
      expect(result.sampledRowCount).toBe(1);
      expect(result.columns.find((column) => column.letter === 'H')?.inferredType).toBe('number');
    });

    it('treats hyperlink and rich text values as strings', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('B3').value = 'Header';
        worksheet.getCell('B4').value = {
          text: 'linked',
          hyperlink: 'https://example.com',
        };
        worksheet.getCell('C3').value = 'Rich';
        worksheet.getCell('C4').value = {
          richText: [{ text: 'rich' }, { text: ' text' }],
        };
      });

      const result = await adapter.getSheetProfile({
        filePath,
        sheetName: 'Data',
      });

      expect(result.columns).toEqual([
        { index: 2, letter: 'B', header: 'Header', inferredType: 'string' },
        { index: 3, letter: 'C', header: 'Rich', inferredType: 'string' },
      ]);
    });

    it('reports missing worksheets with the shared worksheet error', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      await expect(
        adapter.getSheetProfile({ filePath, sheetName: 'Missing' }),
      ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.WORKSHEET_NOT_FOUND });
    });

    it('returns an empty profile for an empty worksheet', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Empty');
      });

      await expect(adapter.getSheetProfile({ filePath, sheetName: 'Empty' })).resolves.toEqual({
        sheetName: 'Empty',
        usedRange: null,
        rowCount: 0,
        columnCount: 0,
        headerRow: null,
        sampledRowCount: 0,
        columns: [],
      });
    });

    it('validates sample size with the requested default and boundaries', () => {
      expect(
        getSheetProfileInputSchema.parse({
          filePath: 'workbook.xlsx',
          sheetName: 'Data',
        }).sampleSize,
      ).toBe(50);
      expect(
        getSheetProfileInputSchema.parse({
          filePath: 'workbook.xlsx',
          sheetName: 'Data',
          sampleSize: 1,
        }).sampleSize,
      ).toBe(1);
      expect(
        getSheetProfileInputSchema.parse({
          filePath: 'workbook.xlsx',
          sheetName: 'Data',
          sampleSize: 200,
        }).sampleSize,
      ).toBe(200);
      expect(() =>
        getSheetProfileInputSchema.parse({
          filePath: 'workbook.xlsx',
          sheetName: 'Data',
          sampleSize: 0,
        }),
      ).toThrow();
      expect(() =>
        getSheetProfileInputSchema.parse({
          filePath: 'workbook.xlsx',
          sheetName: 'Data',
          sampleSize: 201,
        }),
      ).toThrow();
    });

    it('honors an already-aborted signal', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('A1').value = 'value';
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        adapter.getSheetProfile({ filePath, sheetName: 'Data' }, controller.signal),
      ).rejects.toMatchObject({
        code: ExcelCapabilityErrorCode.EXCEL_OPERATION_FAILED,
        message: "Excel operation 'getSheetProfile' was cancelled",
      });
    });
  });
});

async function createProfileWorkbook(filePath: string): Promise<void> {
  await createWorkbook(filePath, (workbook) => {
    const worksheet = workbook.addWorksheet('Profile');
    worksheet.getCell('B3').value = 'Name';
    worksheet.getCell('C3').value = 'Count';
    worksheet.getCell('D3').value = 'Active';
    worksheet.getCell('E3').value = 'Date';
    worksheet.getCell('F3').value = 'Formula';
    worksheet.getCell('H3').value = 'Name';
    worksheet.getCell('I3').value = 'Empty';
    worksheet.getCell('J3').value = 'Error';

    worksheet.getCell('B4').value = 'Alice';
    worksheet.getCell('C4').value = 1;
    worksheet.getCell('D4').value = true;
    worksheet.getCell('E4').value = new Date('2025-01-01T00:00:00.000Z');
    worksheet.getCell('F4').value = { formula: 'C4*2', result: 2 };
    worksheet.getCell('G4').value = 'text';
    worksheet.getCell('H4').value = 1;
    worksheet.getCell('J4').value = { error: '#N/A' };

    worksheet.getCell('B5').value = 'Bob';
    worksheet.getCell('C5').value = 2;
    worksheet.getCell('D5').value = false;
    worksheet.getCell('E5').value = new Date('2025-01-02T00:00:00.000Z');
    worksheet.getCell('F5').value = { formula: 'C5*2', result: 4 };
    worksheet.getCell('G5').value = 2;
    worksheet.getCell('H5').value = 'two';
    worksheet.getCell('J5').value = { error: '#VALUE!' };
  });
}

async function createWorkbook(
  filePath: string,
  configure: (workbook: Workbook) => void,
): Promise<void> {
  const workbook = new Workbook();
  configure(workbook);
  await workbook.xlsx.writeFile(filePath);
}
