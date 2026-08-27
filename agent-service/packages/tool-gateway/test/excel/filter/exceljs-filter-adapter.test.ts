import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workbook } from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ExcelCapabilityErrorCode,
  ExcelJsFilterAdapter,
  filterDataInputSchema,
} from '../../../src/index.js';

describe('ExcelJsFilterAdapter', () => {
  let directory: string;
  let filePath: string;
  let adapter: ExcelJsFilterAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-filter-'));
    filePath = join(directory, 'workbook.xlsx');
    adapter = new ExcelJsFilterAdapter();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('filters exact string and numeric values with strict types', async () => {
    await createTableWorkbook(filePath);

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Sales',
        conditions: [{ column: 'Region', operator: 'equals', value: 'East' }],
      }),
    ).resolves.toEqual({
      sheetName: 'Sales',
      sourceRowCount: 5,
      matchedRowCount: 2,
      matchedRanges: [{ startRow: 2, endRow: 3 }],
    });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Sales',
        conditions: [{ column: 'Amount', operator: 'equals', value: '10' }],
      }),
    ).resolves.toMatchObject({ matchedRowCount: 0, matchedRanges: [] });
  });

  it('supports notEquals and treats an empty cell as not equal', async () => {
    await createTableWorkbook(filePath);

    const result = await adapter.filterData({
      filePath,
      sheetName: 'Sales',
      conditions: [{ column: 'Region', operator: 'notEquals', value: 'East' }],
    });

    expect(result).toEqual({
      sheetName: 'Sales',
      sourceRowCount: 5,
      matchedRowCount: 3,
      matchedRanges: [{ startRow: 4, endRow: 6 }],
    });
  });

  it.each([
    [
      'greaterThan',
      10,
      [
        { startRow: 3, endRow: 3 },
        { startRow: 5, endRow: 6 },
      ],
    ],
    [
      'lessThan',
      20,
      [
        { startRow: 2, endRow: 2 },
        { startRow: 4, endRow: 5 },
      ],
    ],
  ] as const)('supports %s for numeric values', async (operator, value, ranges) => {
    await createTableWorkbook(filePath);

    const result = await adapter.filterData({
      filePath,
      sheetName: 'Sales',
      conditions: [{ column: 'Amount', operator, value }],
    });

    expect(result.matchedRanges).toEqual(ranges);
    expect(result.matchedRowCount).toBe(
      ranges.reduce((count, range) => count + range.endRow - range.startRow + 1, 0),
    );
  });

  it('supports Date comparisons by timestamp', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Dates');
      worksheet.getCell('A1').value = 'When';
      worksheet.getCell('A2').value = new Date('2025-01-01T00:00:00.000Z');
      worksheet.getCell('A3').value = new Date('2025-02-01T00:00:00.000Z');
    });

    const result = await adapter.filterData({
      filePath,
      sheetName: 'Dates',
      conditions: [
        { column: 'When', operator: 'greaterThan', value: new Date('2025-01-15T00:00:00.000Z') },
      ],
    });

    expect(result.matchedRanges).toEqual([{ startRow: 3, endRow: 3 }]);
  });

  it('supports case-sensitive contains', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Text');
      worksheet.getCell('A1').value = 'Description';
      worksheet.getCell('A2').value = 'East region';
      worksheet.getCell('A3').value = 'east region';
    });

    const result = await adapter.filterData({
      filePath,
      sheetName: 'Text',
      conditions: [{ column: 'Description', operator: 'contains', value: 'East' }],
    });

    expect(result.matchedRanges).toEqual([{ startRow: 2, endRow: 2 }]);
  });

  it('distinguishes null cells from empty strings for empty predicates', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('EmptyValues');
      worksheet.getCell('A1').value = 'Region';
      worksheet.getCell('B1').value = 'Marker';
      worksheet.getCell('A2').value = '';
      worksheet.getCell('B2').value = 'empty string is a value';
      worksheet.getCell('A3').value = null;
      worksheet.getCell('B3').value = 'null is empty';
    });

    const emptyResult = await adapter.filterData({
      filePath,
      sheetName: 'EmptyValues',
      conditions: [{ column: 'Region', operator: 'isEmpty' }],
    });
    const nonEmptyResult = await adapter.filterData({
      filePath,
      sheetName: 'EmptyValues',
      conditions: [{ column: 'Region', operator: 'isNotEmpty' }],
    });

    expect(emptyResult.matchedRanges).toEqual([{ startRow: 3, endRow: 3 }]);
    expect(nonEmptyResult.matchedRanges).toEqual([{ startRow: 2, endRow: 2 }]);
  });

  it('combines conditions with all and any logic', async () => {
    await createTableWorkbook(filePath);

    const allResult = await adapter.filterData({
      filePath,
      sheetName: 'Sales',
      conditions: [
        { column: 'Region', operator: 'equals', value: 'East' },
        { column: 'Amount', operator: 'greaterThan', value: 10 },
      ],
      logic: 'all',
    });
    const anyResult = await adapter.filterData({
      filePath,
      sheetName: 'Sales',
      conditions: [
        { column: 'Region', operator: 'equals', value: 'East' },
        { column: 'Amount', operator: 'equals', value: 20 },
      ],
      logic: 'any',
    });

    expect(allResult.matchedRanges).toEqual([{ startRow: 3, endRow: 3 }]);
    expect(anyResult.matchedRanges).toEqual([{ startRow: 2, endRow: 3 }]);
  });

  it('supports multiple conditions on the same source column', async () => {
    await createTableWorkbook(filePath);

    const result = await adapter.filterData({
      filePath,
      sheetName: 'Sales',
      conditions: [
        { column: 'Amount', operator: 'greaterThan', value: 5 },
        { column: 'Amount', operator: 'lessThan', value: 20 },
      ],
    });

    expect(result.matchedRanges).toEqual([
      { startRow: 2, endRow: 2 },
      { startRow: 5, endRow: 5 },
    ]);
  });

  it('skips completely blank rows and compresses contiguous matches', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Rows');
      worksheet.getCell('A1').value = 'Region';
      worksheet.getCell('B1').value = 'Amount';
      worksheet.getCell('A2').value = 'East';
      worksheet.getCell('B2').value = 10;
      worksheet.getCell('A4').value = 'East';
      worksheet.getCell('B4').value = 20;
      worksheet.getCell('A5').value = 'South';
      worksheet.getCell('B5').value = 30;
    });

    const result = await adapter.filterData({
      filePath,
      sheetName: 'Rows',
      conditions: [{ column: 'Region', operator: 'equals', value: 'East' }],
    });

    expect(result.sourceRowCount).toBe(3);
    expect(result.matchedRowCount).toBe(2);
    expect(result.matchedRanges).toEqual([
      { startRow: 2, endRow: 2 },
      { startRow: 4, endRow: 4 },
    ]);
  });

  it('includes a row when the filter column is empty but another column has data', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Partial');
      worksheet.getCell('A1').value = 'Region';
      worksheet.getCell('B1').value = 'Amount';
      worksheet.getCell('A2').value = 'East';
      worksheet.getCell('B2').value = 10;
      worksheet.getCell('B3').value = 20;
    });

    const result = await adapter.filterData({
      filePath,
      sheetName: 'Partial',
      conditions: [{ column: 'Region', operator: 'isEmpty' }],
    });

    expect(result.sourceRowCount).toBe(2);
    expect(result.matchedRanges).toEqual([{ startRow: 3, endRow: 3 }]);
  });

  it('uses cached numeric and string formula results', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Formulas');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('B1').value = 'Label';
      worksheet.getCell('A2').value = { formula: '1+1', result: 2 };
      worksheet.getCell('B2').value = { formula: '"East"', result: 'East' };
      worksheet.getCell('A3').value = { formula: '2+2', result: 4 };
      worksheet.getCell('B3').value = { formula: '"South"', result: 'South' };
    });

    const numericResult = await adapter.filterData({
      filePath,
      sheetName: 'Formulas',
      conditions: [{ column: 'Amount', operator: 'greaterThan', value: 1 }],
    });
    const stringResult = await adapter.filterData({
      filePath,
      sheetName: 'Formulas',
      conditions: [{ column: 'Label', operator: 'contains', value: 'East' }],
    });

    expect(numericResult.matchedRanges).toEqual([{ startRow: 2, endRow: 3 }]);
    expect(stringResult.matchedRanges).toEqual([{ startRow: 2, endRow: 2 }]);
  });

  it('rejects formulas without cached results', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('NoResult');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('A2').value = { formula: '1+1' };
    });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'NoResult',
        conditions: [{ column: 'Amount', operator: 'equals', value: 2 }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.INVALID_FILTER_VALUE });
  });

  it('rejects incompatible comparison and contains values', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Invalid');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('B1').value = 'Label';
      worksheet.getCell('A2').value = 'not numeric';
      worksheet.getCell('B2').value = 10;
    });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Invalid',
        conditions: [{ column: 'Amount', operator: 'greaterThan', value: 2 }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.INVALID_FILTER_VALUE });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Invalid',
        conditions: [{ column: 'Label', operator: 'contains', value: '1' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.INVALID_FILTER_VALUE });
  });

  it('reports missing and ambiguous headers with details', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Headers');
      worksheet.getCell('A1').value = 'Name';
      worksheet.getCell('B1').value = 'Name';
    });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Headers',
        conditions: [{ column: 'Missing', operator: 'isEmpty' }],
      }),
    ).rejects.toMatchObject({
      code: ExcelCapabilityErrorCode.COLUMN_NOT_FOUND,
      details: {
        sheetName: 'Headers',
        column: 'Missing',
        availableColumns: ['Name', 'Name'],
        matches: [],
      },
    });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Headers',
        conditions: [{ column: 'Name', operator: 'isNotEmpty' }],
      }),
    ).rejects.toMatchObject({
      code: ExcelCapabilityErrorCode.AMBIGUOUS_COLUMN,
      details: { matches: ['A1', 'B1'] },
    });
  });

  it('reports empty worksheets, missing worksheets, and missing workbooks', async () => {
    await createWorkbook(filePath, (workbook) => {
      workbook.addWorksheet('Empty');
    });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Empty',
        conditions: [{ column: 'Amount', operator: 'isEmpty' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.COLUMN_NOT_FOUND });

    await expect(
      adapter.filterData({
        filePath,
        sheetName: 'Missing',
        conditions: [{ column: 'Amount', operator: 'isEmpty' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.WORKSHEET_NOT_FOUND });

    await expect(
      adapter.filterData({
        filePath: join(directory, 'missing.xlsx'),
        sheetName: 'Empty',
        conditions: [{ column: 'Amount', operator: 'isEmpty' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.WORKBOOK_OPEN_FAILED });
  });

  it('honors AbortSignal cancellation', async () => {
    await createTableWorkbook(filePath);
    const controller = new AbortController();
    controller.abort('cancelled by caller');

    await expect(
      adapter.filterData(
        {
          filePath,
          sheetName: 'Sales',
          conditions: [{ column: 'Region', operator: 'equals', value: 'East' }],
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: ExcelCapabilityErrorCode.EXCEL_OPERATION_FAILED,
      message: "Excel operation 'filterData' was cancelled",
    });
  });

  it('validates condition combinations, trims strings, and defaults logic', () => {
    expect(
      filterDataInputSchema.parse({
        filePath: ' workbook.xlsx ',
        sheetName: ' Sales ',
        conditions: [{ column: ' Region ', operator: 'equals', value: 'East' }],
      }),
    ).toEqual({
      filePath: 'workbook.xlsx',
      sheetName: 'Sales',
      conditions: [{ column: 'Region', operator: 'equals', value: 'East' }],
      logic: 'all',
    });

    expect(() =>
      filterDataInputSchema.parse({
        filePath: 'workbook.xlsx',
        sheetName: 'Sales',
        conditions: [],
      }),
    ).toThrow();
    expect(() =>
      filterDataInputSchema.parse({
        filePath: 'workbook.xlsx',
        sheetName: 'Sales',
        conditions: [{ column: 'Region', operator: 'equals' }],
      }),
    ).toThrow();
    expect(() =>
      filterDataInputSchema.parse({
        filePath: 'workbook.xlsx',
        sheetName: 'Sales',
        conditions: [{ column: 'Region', operator: 'isEmpty', value: 'East' }],
      }),
    ).toThrow();
  });
});

/** Creates the shared sales table used by operator and logic tests. */
async function createTableWorkbook(filePath: string): Promise<void> {
  await createWorkbook(filePath, (workbook) => {
    const worksheet = workbook.addWorksheet('Sales');
    worksheet.getCell('A1').value = 'Region';
    worksheet.getCell('B1').value = 'Amount';
    worksheet.getCell('A2').value = 'East';
    worksheet.getCell('B2').value = 10;
    worksheet.getCell('A3').value = 'East';
    worksheet.getCell('B3').value = 20;
    worksheet.getCell('A4').value = 'South';
    worksheet.getCell('B4').value = 5;
    worksheet.getCell('A5').value = 'West';
    worksheet.getCell('B5').value = 15;
    worksheet.getCell('A6').value = null;
    worksheet.getCell('B6').value = 25;
  });
}

/** Creates and persists a workbook using the supplied worksheet configuration. */
async function createWorkbook(
  filePath: string,
  configure: (workbook: Workbook) => void,
): Promise<void> {
  const workbook = new Workbook();
  configure(workbook);
  await workbook.xlsx.writeFile(filePath);
}
