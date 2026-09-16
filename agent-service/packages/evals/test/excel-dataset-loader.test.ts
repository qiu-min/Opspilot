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
  it('loads all checked-in sales Golden Cases with fixed expected values', async () => {
    const cases = await loadExcelCases();
    const excelCase = cases[0];
    const rowCountCase = cases[1];
    const topRegionSalesCase = cases[2];
    const writeCase = cases[3];

    expect(cases).toHaveLength(4);
    expect(excelCase).toMatchObject({
      id: 'excel-sheet-count-001',
      expected: {
        sheetCount: 3,
        behavior: {
          requiredTools: ['get_workbook_info'],
          forbiddenTools: ['write_data'],
          maxToolErrors: 0,
        },
      },
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
        behavior: {
          requiredTools: ['get_sheet_profile'],
          forbiddenTools: ['write_data'],
          maxToolErrors: 0,
        },
      },
      input: {
        message:
          'Sales 工作表有多少行数据？请检查工作簿中的所有工作表，并分别告诉我每个工作表有多少行数据以及多少行标题。',
        excelResource: { id: 'excel-sales-workbook' },
      },
      tags: ['excel', 'discovery', 'row-count', 'golden'],
    });

    expect(topRegionSalesCase).toMatchObject({
      id: 'excel-top-region-sales-003',
      expected: {
        topRegionSales: {
          sheetName: 'SalesData',
          region: 'South',
          totalSales: 92726.94,
          orderCount: 40,
        },
        behavior: {
          requiredTools: ['aggregate_data'],
          forbiddenTools: ['write_data'],
          maxToolErrors: 0,
        },
      },
      input: {
        message: 'SalesData 工作表中哪个地区的销售额最高？请告诉我该地区、销售额合计以及订单数。',
        excelResource: { id: 'excel-sales-workbook' },
      },
      tags: ['excel', 'analysis', 'aggregate', 'golden'],
    });

    expect(writeCase).toMatchObject({
      id: 'excel-write-cell-004',
      expected: {
        workbookMutation: {
          sheetName: 'MonthlySummary',
          range: 'H2',
          expectedValues: [['Verified']],
        },
        behavior: { requiredTools: ['write_data'], maxToolErrors: 0 },
      },
      input: {
        message: '请在 MonthlySummary 工作表的 H2 单元格写入 Verified。',
        excelResource: { id: 'excel-sales-workbook' },
      },
      tags: ['excel', 'write', 'mutation', 'golden'],
    });
  });

  it.each([
    { sheetName: '', range: 'H2', expectedValues: [['Verified']] },
    { sheetName: 'MonthlySummary', range: '', expectedValues: [['Verified']] },
    { sheetName: 'MonthlySummary', range: 'H2', expectedValues: [] },
    { sheetName: 'MonthlySummary', range: 'H2', expectedValues: ['Verified'] },
  ])('rejects malformed workbookMutation expected values: %j', async (workbookMutation) => {
    await expectWorkbookMutationToReject(workbookMutation, /workbookMutation/);
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

  it('rejects malformed topRegionSales expected values', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opspilot-evals-loader-'));
    const datasetPath = join(directory, 'cases.json');
    await writeFile(
      datasetPath,
      JSON.stringify([
        {
          id: 'invalid-top-region-sales',
          name: 'Invalid top region sales',
          input: 'test',
          workbook: 'sales.xlsx',
          expected: {
            topRegionSales: {
              sheetName: 'SalesData',
              region: 'South',
              totalSales: Number.NaN,
              orderCount: 40,
            },
          },
          tags: ['excel'],
        },
      ]),
      'utf8',
    );
    try {
      await expect(loadExcelCases(datasetPath)).rejects.toThrow(/totalSales/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([-1, 1.5, '0'])('rejects invalid behavior.maxToolErrors: %s', async (maxToolErrors) => {
    await expectBehaviorToReject({ maxToolErrors }, /maxToolErrors/);
  });

  it('rejects duplicate behavior.requiredTools', async () => {
    await expectBehaviorToReject(
      { requiredTools: ['aggregate_data', 'aggregate_data'] },
      /requiredTools.*duplicates/,
    );
  });

  it('rejects a tool declared as both required and forbidden', async () => {
    await expectBehaviorToReject(
      { requiredTools: ['write_data'], forbiddenTools: ['write_data'] },
      /both required and forbidden/,
    );
  });
});

async function expectBehaviorToReject(behavior: unknown, message: RegExp): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'opspilot-evals-loader-'));
  const datasetPath = join(directory, 'cases.json');
  await writeFile(
    datasetPath,
    JSON.stringify([
      {
        id: 'invalid-behavior',
        name: 'Invalid behavior',
        input: 'test',
        workbook: 'sales.xlsx',
        expected: { sheetCount: 3, behavior },
        tags: ['excel'],
      },
    ]),
    'utf8',
  );
  try {
    await expect(loadExcelCases(datasetPath)).rejects.toThrow(message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function expectWorkbookMutationToReject(
  workbookMutation: unknown,
  message: RegExp,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'opspilot-evals-loader-'));
  const datasetPath = join(directory, 'cases.json');
  await writeFile(
    datasetPath,
    JSON.stringify([
      {
        id: 'invalid-workbook-mutation',
        name: 'Invalid workbook mutation',
        input: 'test',
        workbook: 'sales.xlsx',
        expected: { workbookMutation },
        tags: ['excel'],
      },
    ]),
    'utf8',
  );
  try {
    await expect(loadExcelCases(datasetPath)).rejects.toThrow(message);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isResourceInput(input: AgentEvalInput | undefined): input is AgentEvalInputWithResource {
  return typeof input === 'object' && input !== null && 'message' in input;
}
