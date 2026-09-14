import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workbook, type CellValue, type Worksheet } from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectHeaderRow } from '../../../src/excel/shared/exceljs/header-detection.js';
import { findUsedRange } from '../../../src/excel/shared/exceljs/used-range.js';

describe('detectHeaderRow', () => {
  let directory: string;
  let filePath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-header-'));
    filePath = join(directory, 'workbook.xlsx');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('detects a normal table with high confidence', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      setRow(sheet, 1, ['Product', 'Region', 'Amount']);
      setRow(sheet, 2, ['A', 'East', 100]);
      setRow(sheet, 3, ['B', 'South', 200]);
    });

    const result = detect(worksheet);

    expect(result.headerRow).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('prefers a header after a title and blank row', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      sheet.getCell('A1').value = '2025 Sales Report';
      setRow(sheet, 3, ['Product', 'Region', 'Amount']);
      setRow(sheet, 4, ['A', 'East', 100]);
      setRow(sheet, 5, ['B', 'South', 200]);
    });

    expect(detect(worksheet).headerRow).toBe(3);
  });

  it('penalizes a merged title before the tabular header', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      sheet.mergeCells('A1:C1');
      sheet.getCell('A1').value = '2025 Sales Report';
      setRow(sheet, 3, ['Product', 'Region', 'Amount']);
      setRow(sheet, 4, ['A', 'East', 100]);
      setRow(sheet, 5, ['B', 'South', 200]);
    });

    expect(detect(worksheet).headerRow).toBe(3);
  });

  it('skips preceding explanatory text rows', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      sheet.getCell('A1').value = 'Generated: 2026-09-14';
      sheet.getCell('A2').value = 'Source: ERP';
      setRow(sheet, 4, ['OrderId', 'Region', 'Amount']);
      setRow(sheet, 5, ['001', 'East', 100]);
      setRow(sheet, 6, ['002', 'South', 200]);
    });

    expect(detect(worksheet).headerRow).toBe(4);
  });

  it('uses a clear header and data type boundary', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      setRow(sheet, 1, ['Product', 'Date', 'Amount']);
      setRow(sheet, 2, ['A', new Date('2026-01-01T00:00:00.000Z'), 100]);
      setRow(sheet, 3, ['B', new Date('2026-01-02T00:00:00.000Z'), 200]);
    });

    const result = detect(worksheet);

    expect(result.headerRow).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('returns no header for numeric-only rows', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      setRow(sheet, 1, [100, 200, 300]);
      setRow(sheet, 2, [400, 500, 600]);
      setRow(sheet, 3, [700, 800, 900]);
    });

    const result = detect(worksheet);

    expect(result.headerRow).toBeNull();
    expect(result.confidence).toBeLessThan(0.47);
  });

  it('does not let a single-cell title beat a complete header row', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      sheet.getCell('A1').value = 'Annual Sales Data';
      setRow(sheet, 3, ['Product', 'Region', 'Amount']);
      setRow(sheet, 4, ['A', 'East', 100]);
    });

    expect(detect(worksheet).headerRow).toBe(3);
  });

  it('honors an already-aborted signal', async () => {
    const worksheet = await createWorksheet(filePath, (sheet) => {
      setRow(sheet, 1, ['Product', 'Amount']);
      setRow(sheet, 2, ['A', 100]);
    });
    const controller = new AbortController();
    controller.abort('cancelled by caller');

    expect(() => detect(worksheet, controller.signal)).toThrow(
      "Excel operation 'detectHeaderRow' was cancelled",
    );
  });

  function detect(worksheet: Worksheet, signal?: AbortSignal) {
    return detectHeaderRow(worksheet, findUsedRange(worksheet, 'values'), signal);
  }
});

async function createWorksheet(
  filePath: string,
  configure: (worksheet: Worksheet) => void,
): Promise<Worksheet> {
  const workbook = new Workbook();
  const worksheet = workbook.addWorksheet('Data');
  configure(worksheet);
  await workbook.xlsx.writeFile(filePath);

  const persistedWorkbook = new Workbook();
  await persistedWorkbook.xlsx.readFile(filePath);
  return persistedWorkbook.getWorksheet('Data')!;
}

function setRow(worksheet: Worksheet, row: number, values: readonly CellValue[]): void {
  values.forEach((value, offset) => {
    worksheet.getCell(row, offset + 1).value = value;
  });
}
