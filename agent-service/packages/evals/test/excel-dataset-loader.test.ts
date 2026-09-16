import { isAbsolute, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadExcelCases } from '../src/datasets/excel-dataset-loader.js';
import type {
  AgentEvalInput,
  AgentEvalInputWithResource,
} from '../src/executors/agent-eval-executor.js';

describe('loadExcelCases', () => {
  it('loads the checked-in sales Golden Case with a fixed expected count', async () => {
    const cases = await loadExcelCases();
    const excelCase = cases[0];

    expect(cases).toHaveLength(1);
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
  });
});

function isResourceInput(input: AgentEvalInput | undefined): input is AgentEvalInputWithResource {
  return typeof input === 'object' && input !== null && 'message' in input;
}
