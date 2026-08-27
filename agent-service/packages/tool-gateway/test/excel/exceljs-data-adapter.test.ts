import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workbook } from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ExcelCapabilityErrorCode,
  ExcelJsDataAdapter,
} from '../../src/index.js';

describe('ExcelJsDataAdapter', () => {
  let directory: string;
  let filePath: string;
  let adapter: ExcelJsDataAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-'));
    filePath = join(directory, 'workbook.xlsx');
    adapter = new ExcelJsDataAdapter();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  describe('readRange', () => {
    it('reads the worksheet used area and preserves empty columns', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('A1').value = 'Name';
        worksheet.getCell('C1').value = 'Status';
        worksheet.getCell('A2').value = 'Alice';
        worksheet.getCell('C2').value = 'Ready';
      });

      const result = await adapter.readRange({
        filePath,
        sheetName: 'Data',
        startCell: 'A1',
      });

      expect(result).toEqual({
        sheetName: 'Data',
        range: 'A1:C2',
        values: [
          ['Name', null, 'Status'],
          ['Alice', null, 'Ready'],
        ],
      });
    });

    it('reads an explicitly requested range', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('A1').value = 'Name';
        worksheet.getCell('C1').value = 'Status';
        worksheet.getCell('A2').value = 'Alice';
        worksheet.getCell('C2').value = 'Ready';
      });

      const result = await adapter.readRange({
        filePath,
        sheetName: 'Data',
        startCell: 'B1',
        endCell: 'C2',
      });

      expect(result.range).toBe('B1:C2');
      expect(result.values).toEqual([
        [null, 'Status'],
        [null, 'Ready'],
      ]);
    });

    it('accepts a range in startCell', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('A1').value = 'A';
        worksheet.getCell('B2').value = 'B';
      });

      const result = await adapter.readRange({
        filePath,
        sheetName: 'Data',
        startCell: 'A1:B2',
      });

      expect(result.range).toBe('A1:B2');
      expect(result.values).toEqual([
        ['A', null],
        [null, 'B'],
      ]);
    });

    it('reports a missing worksheet with a capability error', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      await expect(
        adapter.readRange({
          filePath,
          sheetName: 'Missing',
          startCell: 'A1',
        }),
      ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.WORKSHEET_NOT_FOUND });
    });

    it('reports invalid cell references', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      await expect(
        adapter.readRange({
          filePath,
          sheetName: 'Data',
          startCell: 'A0',
        }),
      ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.INVALID_CELL_REFERENCE });
    });

    it('returns an empty result for an empty worksheet', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      const result = await adapter.readRange({
        filePath,
        sheetName: 'Data',
        startCell: 'A1',
      });

      expect(result.values).toEqual([]);
    });

    it('returns an empty result when startCell is outside the used area', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('A1').value = 'value';
      });

      const result = await adapter.readRange({
        filePath,
        sheetName: 'Data',
        startCell: 'Z1',
      });

      expect(result.values).toEqual([]);
    });
  });

  describe('writeData', () => {
    it('writes data from A1 and persists it', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      const result = await adapter.writeData({
        filePath,
        sheetName: 'Data',
        startCell: 'A1',
        data: [
          ['Name', 'Score'],
          ['Alice', 100],
        ],
      });

      const persistedWorkbook = await readWorkbook(filePath);
      const worksheet = persistedWorkbook.getWorksheet('Data');

      expect(result).toEqual({
        sheetName: 'Data',
        range: 'A1:B2',
        message: 'Data written to Data',
      });
      expect(worksheet?.getCell('A1').value).toBe('Name');
      expect(worksheet?.getCell('B2').value).toBe(100);
    });

    it('writes a two-dimensional array from a non-A1 start', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      const result = await adapter.writeData({
        filePath,
        sheetName: 'Data',
        startCell: 'C3',
        data: [
          ['left', 'right'],
          [1, 2],
        ],
      });

      const persistedWorkbook = await readWorkbook(filePath);
      const worksheet = persistedWorkbook.getWorksheet('Data');

      expect(result.range).toBe('C3:D4');
      expect(worksheet?.getCell('C3').value).toBe('left');
      expect(worksheet?.getCell('D4').value).toBe(2);
    });

    it('uses the active worksheet when sheetName is omitted', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Active');
        workbook.addWorksheet('Other');
      });

      const result = await adapter.writeData({
        filePath,
        startCell: 'A1',
        data: [['active']],
      });

      const persistedWorkbook = await readWorkbook(filePath);

      expect(result.sheetName).toBe('Active');
      expect(persistedWorkbook.getWorksheet('Active')?.getCell('A1').value).toBe('active');
      expect(persistedWorkbook.getWorksheet('Other')?.getCell('A1').value).toBeNull();
    });

    it('creates a worksheet when the requested worksheet does not exist', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      await adapter.writeData({
        filePath,
        sheetName: 'Created',
        startCell: 'B2',
        data: [['new sheet']],
      });

      const persistedWorkbook = await readWorkbook(filePath);
      expect(persistedWorkbook.getWorksheet('Created')?.getCell('B2').value).toBe('new sheet');
    });

    it('reports empty data with the capability error model', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      await expect(
        adapter.writeData({
          filePath,
          sheetName: 'Data',
          startCell: 'A1',
          data: [],
        }),
      ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.EMPTY_DATA });
    });

    it('reports an invalid startCell', async () => {
      await createWorkbook(filePath, (workbook) => {
        workbook.addWorksheet('Data');
      });

      await expect(
        adapter.writeData({
          filePath,
          sheetName: 'Data',
          startCell: 'A0',
          data: [['value']],
        }),
      ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.INVALID_CELL_REFERENCE });
    });
  });

  describe('readRangeWithMetadata', () => {
    it('returns cell coordinates, values, and the actual range', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('B2').value = 'value';
        worksheet.getCell('C3').value = 42;
      });

      const result = await adapter.readRangeWithMetadata({
        filePath,
        sheetName: 'Data',
        startCell: 'A1',
        endCell: 'C3',
        includeValidation: false,
      });

      expect(result.range).toBe('A1:C3');
      expect(result.cells).toHaveLength(9);
      expect(result.cells[0]).toEqual({
        address: 'A1',
        row: 1,
        column: 1,
        value: null,
      });
      expect(result.cells[4]).toEqual({
        address: 'B2',
        row: 2,
        column: 2,
        value: 'value',
      });
      expect(result.cells[8]).toEqual({
        address: 'C3',
        row: 3,
        column: 3,
        value: 42,
      });
    });

    it('omits validation metadata when includeValidation is false', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('A1').dataValidation = {
          type: 'list',
          formulae: ['"Yes,No"'],
        };
      });

      const result = await adapter.readRangeWithMetadata({
        filePath,
        sheetName: 'Data',
        startCell: 'A1',
        endCell: 'A1',
        includeValidation: false,
      });

      expect(result.cells[0]?.validation).toBeUndefined();
    });

    it('maps ExcelJS validation into an OpsPilot DTO when requested', async () => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('B2').value = 'Yes';
        worksheet.getCell('B2').dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: ['"Yes,No"'],
          showErrorMessage: true,
        };
      });

      const result = await adapter.readRangeWithMetadata({
        filePath,
        sheetName: 'Data',
        startCell: 'A1',
        endCell: 'B2',
        includeValidation: true,
      });

      expect(result.cells.find((cell) => cell.address === 'A1')?.validation).toEqual({
        hasValidation: false,
        formulae: [],
      });
      expect(result.cells.find((cell) => cell.address === 'B2')?.validation).toEqual({
        hasValidation: true,
        type: 'list',
        formulae: ['"Yes,No"'],
        allowBlank: true,
        showErrorMessage: true,
      });
    });
  });
});

async function createWorkbook(
  filePath: string,
  configure: (workbook: Workbook) => void,
): Promise<void> {
  const workbook = new Workbook();
  configure(workbook);
  await workbook.xlsx.writeFile(filePath);
}

async function readWorkbook(filePath: string): Promise<Workbook> {
  const workbook = new Workbook();
  await workbook.xlsx.readFile(filePath);
  return workbook;
}
