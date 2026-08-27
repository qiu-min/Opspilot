import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workbook } from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  aggregateDataInputSchema,
  ExcelCapabilityErrorCode,
  ExcelJsAggregateAdapter,
} from '../../../src/index.js';

describe('ExcelJsAggregateAdapter', () => {
  let directory: string;
  let filePath: string;
  let adapter: ExcelJsAggregateAdapter;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-aggregate-'));
    filePath = join(directory, 'workbook.xlsx');
    adapter = new ExcelJsAggregateAdapter();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('aggregates the whole table with all supported operations', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Sales');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('B1').value = 'Order';
      worksheet.getCell('A2').value = 10;
      worksheet.getCell('B2').value = 'first';
      worksheet.getCell('A3').value = 5;
      worksheet.getCell('B3').value = 'second';
      worksheet.getCell('A4').value = 0;
      worksheet.getCell('A5').value = null;
    });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Sales',
        metrics: [
          { column: 'Amount', operation: 'sum' },
          { column: 'Amount', operation: 'count' },
          { column: 'Amount', operation: 'average' },
          { column: 'Amount', operation: 'min' },
          { column: 'Amount', operation: 'max' },
        ],
      }),
    ).resolves.toEqual({
      sheetName: 'Sales',
      columns: [
        { name: 'Amount.sum', kind: 'metric', sourceColumn: 'Amount', operation: 'sum' },
        { name: 'Amount.count', kind: 'metric', sourceColumn: 'Amount', operation: 'count' },
        {
          name: 'Amount.average',
          kind: 'metric',
          sourceColumn: 'Amount',
          operation: 'average',
        },
        { name: 'Amount.min', kind: 'metric', sourceColumn: 'Amount', operation: 'min' },
        { name: 'Amount.max', kind: 'metric', sourceColumn: 'Amount', operation: 'max' },
      ],
      rows: [[15, 3, 5, 0, 10]],
      sourceRowCount: 3,
      resultRowCount: 1,
    });
  });

  it('groups by one column and keeps null groups', async () => {
    await createGroupedWorkbook(filePath);

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Sales',
        groupBy: ['Region'],
        metrics: [
          { column: 'Amount', operation: 'sum', alias: 'Total' },
          { column: 'OrderId', operation: 'count', alias: 'Orders' },
        ],
      }),
    ).resolves.toEqual({
      sheetName: 'Sales',
      columns: [
        { name: 'Region', kind: 'group', sourceColumn: 'Region' },
        { name: 'Total', kind: 'metric', sourceColumn: 'Amount', operation: 'sum' },
        { name: 'Orders', kind: 'metric', sourceColumn: 'OrderId', operation: 'count' },
      ],
      rows: [
        ['East', 30, 2],
        ['South', 5, 1],
        [null, 15, 1],
      ],
      sourceRowCount: 5,
      resultRowCount: 3,
    });
  });

  it('groups by multiple columns with typed collision-safe keys', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'First';
      worksheet.getCell('B1').value = 'Second';
      worksheet.getCell('C1').value = 'Amount';
      worksheet.getCell('A2').value = 1;
      worksheet.getCell('B2').value = '1';
      worksheet.getCell('C2').value = 10;
      worksheet.getCell('A3').value = '1';
      worksheet.getCell('B3').value = '1';
      worksheet.getCell('C3').value = 20;
      worksheet.getCell('A4').value = 'a|b';
      worksheet.getCell('B4').value = 'c';
      worksheet.getCell('C4').value = 30;
      worksheet.getCell('A5').value = 'a';
      worksheet.getCell('B5').value = 'b|c';
      worksheet.getCell('C5').value = 40;
    });

    const result = await adapter.aggregateData({
      filePath,
      sheetName: 'Data',
      groupBy: ['First', 'Second'],
      metrics: [{ column: 'Amount', operation: 'sum' }],
    });

    expect(result.rows).toEqual([
      [1, '1', 10],
      ['1', '1', 20],
      ['a|b', 'c', 30],
      ['a', 'b|c', 40],
    ]);
    expect(result.resultRowCount).toBe(4);
  });

  it('returns the specified alias and preserves source metadata', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('A2').value = 4;
    });

    const result = await adapter.aggregateData({
      filePath,
      sheetName: 'Data',
      metrics: [{ column: 'Amount', operation: 'sum', alias: 'Amount total' }],
    });

    expect(result.columns).toEqual([
      { name: 'Amount total', kind: 'metric', sourceColumn: 'Amount', operation: 'sum' },
    ]);
  });

  it('returns empty-column defaults for every operation', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('B1').value = 'Marker';
      worksheet.getCell('B2').value = 'row exists';
    });

    const result = await adapter.aggregateData({
      filePath,
      sheetName: 'Data',
      metrics: [
        { column: 'Amount', operation: 'sum' },
        { column: 'Amount', operation: 'count' },
        { column: 'Amount', operation: 'average' },
        { column: 'Amount', operation: 'min' },
        { column: 'Amount', operation: 'max' },
      ],
    });

    expect(result.rows).toEqual([[0, 0, null, null, null]]);
    expect(result.sourceRowCount).toBe(1);
  });

  it.each(['sum', 'average', 'min', 'max'] as const)(
    'rejects non-numeric values for %s',
    async (operation) => {
      await createWorkbook(filePath, (workbook) => {
        const worksheet = workbook.addWorksheet('Data');
        worksheet.getCell('A1').value = 'Amount';
        worksheet.getCell('A2').value = 'not numeric';
      });

      await expect(
        adapter.aggregateData({
          filePath,
          sheetName: 'Data',
          metrics: [{ column: 'Amount', operation }],
        }),
      ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.INVALID_AGGREGATION_VALUE });
    },
  );

  it('counts non-empty strings and formulas with cached results', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Value';
      worksheet.getCell('A2').value = 'text';
      worksheet.getCell('A3').value = false;
      worksheet.getCell('A4').value = { formula: '1+1', result: 2 };
      worksheet.getCell('A5').value = null;
    });

    const result = await adapter.aggregateData({
      filePath,
      sheetName: 'Data',
      metrics: [{ column: 'Value', operation: 'count' }],
    });

    expect(result.rows).toEqual([[3]]);
  });

  it('uses cached numeric formula results for numeric operations', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('A2').value = { formula: '1+1', result: 2 };
      worksheet.getCell('A3').value = { formula: '2+2', result: 4 };
    });

    const result = await adapter.aggregateData({
      filePath,
      sheetName: 'Data',
      metrics: [
        { column: 'Amount', operation: 'sum' },
        { column: 'Amount', operation: 'average' },
        { column: 'Amount', operation: 'min' },
        { column: 'Amount', operation: 'max' },
      ],
    });

    expect(result.rows).toEqual([[6, 3, 2, 4]]);
  });

  it('rejects formulas without cached results', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('A2').value = { formula: '1+1' };
    });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Data',
        metrics: [{ column: 'Amount', operation: 'sum' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.INVALID_AGGREGATION_VALUE });
  });

  it('uses cached formula results for group values', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Group';
      worksheet.getCell('B1').value = 'Amount';
      worksheet.getCell('A2').value = { formula: '1+1', result: 2 };
      worksheet.getCell('B2').value = 5;
    });

    const result = await adapter.aggregateData({
      filePath,
      sheetName: 'Data',
      groupBy: ['Group'],
      metrics: [{ column: 'Amount', operation: 'sum' }],
    });

    expect(result.rows).toEqual([[2, 5]]);
  });

  it('reports missing and ambiguous headers with useful details', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Name';
      worksheet.getCell('B1').value = 'Name';
    });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Data',
        metrics: [{ column: 'Missing', operation: 'count' }],
      }),
    ).rejects.toMatchObject({
      code: ExcelCapabilityErrorCode.COLUMN_NOT_FOUND,
      details: {
        sheetName: 'Data',
        column: 'Missing',
        availableColumns: ['Name', 'Name'],
        matches: [],
      },
    });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Data',
        metrics: [{ column: 'Name', operation: 'count' }],
      }),
    ).rejects.toMatchObject({
      code: ExcelCapabilityErrorCode.AMBIGUOUS_COLUMN,
      details: {
        sheetName: 'Data',
        column: 'Name',
        matches: ['A1', 'B1'],
      },
    });
  });

  it('rejects duplicate metric and group output names', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Region';
      worksheet.getCell('B1').value = 'Amount';
      worksheet.getCell('A2').value = 'East';
      worksheet.getCell('B2').value = 1;
    });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Data',
        metrics: [
          { column: 'Amount', operation: 'sum', alias: 'Total' },
          { column: 'Amount', operation: 'count', alias: 'Total' },
        ],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.DUPLICATE_OUTPUT_COLUMN });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Data',
        groupBy: ['Region'],
        metrics: [{ column: 'Amount', operation: 'sum', alias: 'Region' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.DUPLICATE_OUTPUT_COLUMN });
  });

  it('reports an empty sheet as a missing-column error', async () => {
    await createWorkbook(filePath, (workbook) => {
      workbook.addWorksheet('Empty');
    });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Empty',
        metrics: [{ column: 'Amount', operation: 'sum' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.COLUMN_NOT_FOUND });
  });

  it('reports workbook and worksheet failures through shared errors', async () => {
    await expect(
      adapter.aggregateData({
        filePath: join(directory, 'missing.xlsx'),
        sheetName: 'Data',
        metrics: [{ column: 'Amount', operation: 'sum' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.WORKBOOK_OPEN_FAILED });

    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Amount';
    });

    await expect(
      adapter.aggregateData({
        filePath,
        sheetName: 'Missing',
        metrics: [{ column: 'Amount', operation: 'sum' }],
      }),
    ).rejects.toMatchObject({ code: ExcelCapabilityErrorCode.WORKSHEET_NOT_FOUND });
  });

  it('honors AbortSignal cancellation', async () => {
    await createWorkbook(filePath, (workbook) => {
      const worksheet = workbook.addWorksheet('Data');
      worksheet.getCell('A1').value = 'Amount';
      worksheet.getCell('A2').value = 1;
    });
    const controller = new AbortController();
    controller.abort('cancelled by caller');

    await expect(
      adapter.aggregateData(
        { filePath, sheetName: 'Data', metrics: [{ column: 'Amount', operation: 'sum' }] },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      code: ExcelCapabilityErrorCode.EXCEL_OPERATION_FAILED,
      message: "Excel operation 'aggregateData' was cancelled",
    });
  });

  it('validates defaults, trimming, and metric constraints', () => {
    expect(
      aggregateDataInputSchema.parse({
        filePath: ' workbook.xlsx ',
        sheetName: ' Data ',
        metrics: [{ column: ' Amount ', operation: 'sum', alias: ' Total ' }],
      }),
    ).toEqual({
      filePath: 'workbook.xlsx',
      sheetName: 'Data',
      groupBy: [],
      metrics: [{ column: 'Amount', operation: 'sum', alias: 'Total' }],
    });

    expect(() =>
      aggregateDataInputSchema.parse({
        filePath: 'workbook.xlsx',
        sheetName: 'Data',
        metrics: [],
      }),
    ).toThrow();
    expect(() =>
      aggregateDataInputSchema.parse({
        filePath: 'workbook.xlsx',
        sheetName: 'Data',
        metrics: [{ column: 'Amount', operation: 'median' }],
      }),
    ).toThrow();
    expect(() =>
      aggregateDataInputSchema.parse({
        filePath: 'workbook.xlsx',
        sheetName: 'Data',
        metrics: [{ column: 'Amount', operation: 'sum', alias: ' ' }],
      }),
    ).toThrow();
  });
});

/** Creates a workbook containing grouped sales rows and a null group. */
async function createGroupedWorkbook(filePath: string): Promise<void> {
  await createWorkbook(filePath, (workbook) => {
    const worksheet = workbook.addWorksheet('Sales');
    worksheet.getCell('A1').value = 'Region';
    worksheet.getCell('B1').value = 'Amount';
    worksheet.getCell('C1').value = 'OrderId';
    worksheet.getCell('A2').value = 'East';
    worksheet.getCell('B2').value = 10;
    worksheet.getCell('C2').value = 'E-1';
    worksheet.getCell('A3').value = 'East';
    worksheet.getCell('B3').value = 20;
    worksheet.getCell('C3').value = 'E-2';
    worksheet.getCell('A4').value = 'South';
    worksheet.getCell('B4').value = 5;
    worksheet.getCell('C4').value = 'S-1';
    worksheet.getCell('B5').value = null;
    worksheet.getCell('A6').value = null;
    worksheet.getCell('B6').value = 15;
    worksheet.getCell('C6').value = 'N-1';
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
