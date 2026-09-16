import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadExcelCases } from '../src/datasets/excel-dataset-loader.js';
import type {
  AgentEvalInput,
  AgentEvalInputWithResource,
} from '../src/executors/agent-eval-executor.js';

describe('loadExcelCases', () => {
  it('loads both checked-in sales Golden Cases with fixed expected values', async () => {
    const cases = await loadExcelCases();
    const excelCase = cases[0];
    const rowCountCase = cases[1];

    expect(cases).toHaveLength(2);
    expect(excelCase).toMatchObject({
      id: 'excel-sheet-count-001',
      expected: { sheetCount: 3 },
      tags: ['excel', 'discovery', 'golden'],
      input: {
        message: '这个 Excel 工作簿总共有几个工作表？请使用阿拉伯数字明确回答数量。',
        excelResource: { id: 'excel-sales-workbook' },
      },
    });

    const input = excelCase?.input;
    if (!isResourceInput(input)) {
      throw new Error('Expected a resource-bearing Excel case input.');
    }
    const resource = input.excelResource;
    if (resource === undefined) throw new Error('Expected an attached Excel resource.');
    expect(isAbsolute(resource.filePath)).toBe(true);
    expect(resolve(resource.filePath)).toBe(resolve('datasets/excel/sales.xlsx'));

    expect(rowCountCase).toMatchObject({
      id: 'excel-sheet-row-counts-002',
      expected: {
        sheetRows: [
          { sheetName: 'SalesData', dataRowCount: 120, headerRowCount: 1 },
          { sheetName: 'Products', dataRowCount: 8, headerRowCount: 1 },
          { sheetName: 'MonthlySummary', dataRowCount: 7, headerRowCount: 1 },
        ],
      },
      input: {
        message:
          'Sales 工作表有多少行数据？请检查工作簿中的所有工作表，并分别告诉我每个工作表有多少行数据以及多少行标题。',
        excelResource: { id: 'excel-sales-workbook' },
      },
      tags: ['excel', 'discovery', 'row-count', 'golden'],
    });
  });

  it('rejects malformed sheetRows expected values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opspilot-evals-loader-'));
    const datasetPath = join(directory, 'cases.json');
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          id: 'invalid-sheet-rows',
          name: 'Invalid sheet rows',
          input: 'test',
          workbook: 'sales.xlsx',
          expected: {
            sheetRows: [{ sheetName: '', dataRowCount: 1, headerRowCount: 1 }],
          },
          tags: ['excel'],
        },
      ]),
      'utf8',
    );
    try {
      await expect(loadExcelCases(datasetPath)).rejects.toThrow(/sheetRows/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function isResourceInput(input: AgentEvalInput | undefined): input is AgentEvalInputWithResource {
  return typeof input === 'object' && input !== null && 'message' in input;
}
