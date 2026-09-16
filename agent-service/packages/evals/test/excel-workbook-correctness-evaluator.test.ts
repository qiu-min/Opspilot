import type { ExecuteTurnResult } from '@opspilot/application';
import type { AssistantMessage, ToolResultMessage } from '@opspilot/model-gateway';
import { describe, expect, it } from 'vitest';

import type { EvalRunResult } from '../src/core/eval-run-result.js';
import { ExcelWorkbookCorrectnessEvaluator } from '../src/evaluators/excel-workbook-correctness-evaluator.js';

const evaluator = new ExcelWorkbookCorrectnessEvaluator();
const expected = { sheetCount: 3 };
const rowCountExpected = {
  sheetRows: [
    { sheetName: 'SalesData', dataRowCount: 120, headerRowCount: 1 },
    { sheetName: 'Products', dataRowCount: 8, headerRowCount: 1 },
    { sheetName: 'MonthlySummary', dataRowCount: 7, headerRowCount: 1 },
  ],
};
const topRegionSalesExpected = {
  topRegionSales: {
    sheetName: 'SalesData',
    region: 'South',
    totalSales: 92726.94,
    orderCount: 40,
  },
};

describe('ExcelWorkbookCorrectnessEvaluator', () => {
  it('passes when the real tool result and final assistant answer agree', async () => {
    const result = await evaluator.evaluate({
      expected,
      actual: turnResult([workbookInfoResult(3), assistantMessage('这个工作簿共有 3 个工作表。')]),
      run: completedRun(),
    });

    expect(result).toMatchObject({
      evaluator: 'excel_workbook_correctness',
      score: 1,
      passed: true,
      details: { expectedSheetCount: 3, actualToolSheetCount: 3 },
    });
  });

  it('fails when get_workbook_info returns a different sheet count', async () => {
    const result = await evaluator.evaluate({
      expected,
      actual: turnResult([workbookInfoResult(2), assistantMessage('这个工作簿共有 2 个工作表。')]),
      run: completedRun(),
    });

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'Expected sheetCount 3 but tool returned 2.',
      details: { expectedSheetCount: 3, actualToolSheetCount: 2 },
    });
  });

  it('fails when get_workbook_info has no tool result', async () => {
    const result = await evaluator.evaluate({
      expected,
      actual: turnResult([assistantMessage('这个工作簿共有 3 个工作表。')]),
      run: completedRun(),
    });

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'get_workbook_info was not executed.',
      details: { expectedSheetCount: 3 },
    });
  });

  it('fails when the tool result is correct but the final answer is wrong', async () => {
    const result = await evaluator.evaluate({
      expected,
      actual: turnResult([workbookInfoResult(3), assistantMessage('这个工作簿共有 2 个工作表。')]),
      run: completedRun(),
    });

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'The workbook tool returned the correct sheet count, but the final assistant answer did not contain the expected value 3.',
      details: { expectedSheetCount: 3, actualToolSheetCount: 3 },
    });
  });

  it('fails when get_workbook_info is an error result', async () => {
    const result = await evaluator.evaluate({
      expected,
      actual: turnResult([workbookInfoResult(3, true), assistantMessage('我无法读取这个工作簿。')]),
      run: completedRun(),
    });

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'get_workbook_info tool execution failed.',
      details: { expectedSheetCount: 3 },
    });
  });

  it('passes when all three sheet profiles and the final answer are correct', async () => {
    const result = await evaluator.evaluate({
      expected: rowCountExpected,
      actual: turnResult([
        sheetProfileResult('SalesData', 121),
        sheetProfileResult('Products', 9),
        sheetProfileResult('MonthlySummary', 8),
        assistantMessage(
          'SalesData 有 120 行数据，另有 1 行标题；Products 有 8 行数据，另有 1 行标题；MonthlySummary 有 7 行数据，另有 1 行标题。',
        ),
      ]),
      run: completedRun('excel-sheet-row-counts-002'),
    });

    expect(result).toEqual({
      evaluator: 'excel_workbook_correctness',
      score: 1,
      passed: true,
      details: {
        sheets: [
          {
            sheetName: 'SalesData',
            expectedDataRowCount: 120,
            expectedHeaderRowCount: 1,
            actualToolRowCount: 121,
            actualDataRowCount: 120,
          },
          {
            sheetName: 'Products',
            expectedDataRowCount: 8,
            expectedHeaderRowCount: 1,
            actualToolRowCount: 9,
            actualDataRowCount: 8,
          },
          {
            sheetName: 'MonthlySummary',
            expectedDataRowCount: 7,
            expectedHeaderRowCount: 1,
            actualToolRowCount: 8,
            actualDataRowCount: 7,
          },
        ],
      },
    });
  });

  it('fails when SalesData has the wrong total row count', async () => {
    const result = await evaluateRows([
      sheetProfileResult('SalesData', 120),
      sheetProfileResult('Products', 9),
      sheetProfileResult('MonthlySummary', 8),
      assistantMessage('SalesData 119 行数据；Products 8 行数据；MonthlySummary 7 行数据。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'Expected SalesData to contain 120 data rows, but calculated 119 from get_sheet_profile.',
    });
  });

  it('fails when Products has no successful profile result', async () => {
    const result = await evaluateRows([
      sheetProfileResult('SalesData', 121),
      sheetProfileResult('MonthlySummary', 8),
      assistantMessage('SalesData 120 行数据；Products 8 行数据；MonthlySummary 7 行数据。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'No successful get_sheet_profile result was found for Products.',
    });
  });

  it('fails when MonthlySummary profile is an error result', async () => {
    const result = await evaluateRows([
      sheetProfileResult('SalesData', 121),
      sheetProfileResult('Products', 9),
      sheetProfileResult('MonthlySummary', 8, true),
      assistantMessage('SalesData 120 行数据；Products 8 行数据；MonthlySummary 7 行数据。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'No successful get_sheet_profile result was found for MonthlySummary.',
    });
  });

  it('fails when tool results are correct but SalesData is reported as 121 data rows', async () => {
    const result = await evaluateRows([
      sheetProfileResult('SalesData', 121),
      sheetProfileResult('Products', 9),
      sheetProfileResult('MonthlySummary', 8),
      assistantMessage('SalesData 121 行数据；Products 8 行数据；MonthlySummary 7 行数据。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'The tool results were correct, but the final assistant answer did not report SalesData as having 120 data rows.',
    });
  });

  it('fails when the correct numbers are assigned to the wrong sheets', async () => {
    const result = await evaluateRows([
      sheetProfileResult('SalesData', 121),
      sheetProfileResult('Products', 9),
      sheetProfileResult('MonthlySummary', 8),
      assistantMessage('SalesData 8 行数据；Products 120 行数据；MonthlySummary 7 行数据。'),
    ]);

    expect(result).toMatchObject({ score: 0, passed: false });
    expect(result.reason).toContain('SalesData');
  });

  it('passes Case 3 using structured column metadata rather than metric aliases', async () => {
    const result = await evaluateTopRegion([
      aggregateDataResult(),
      assistantMessage('销售额最高的是 South，销售额合计为 92,726.94，共 40 笔订单。'),
    ]);

    expect(result).toEqual({
      evaluator: 'excel_workbook_correctness',
      score: 1,
      passed: true,
      details: {
        sheetName: 'SalesData',
        expectedRegion: 'South',
        actualRegion: 'South',
        expectedTotalSales: 92726.94,
        actualTotalSales: 92726.94,
        expectedOrderCount: 40,
        actualOrderCount: 40,
        highestSalesVerified: true,
      },
    });
  });

  it('fails Case 3 when aggregate_data was not executed', async () => {
    const result = await evaluateTopRegion([
      assistantMessage('销售额最高的是 South，销售额合计为 92,726.94，共 40 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'aggregate_data was not executed.',
    });
  });

  it('fails Case 3 when aggregate_data returns an error', async () => {
    const result = await evaluateTopRegion([
      aggregateDataResult([], { isError: true }),
      assistantMessage('我无法读取聚合结果。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'aggregate_data tool execution failed.',
    });
  });

  it('fails Case 3 when South has the wrong sales total', async () => {
    const rows = completeRegionalRows();
    rows[1] = ['South', 92000, 40];
    const result = await evaluateTopRegion([
      aggregateDataResult(rows),
      assistantMessage('销售额最高的是 South，销售额合计为 92,000，共 40 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'Expected South total sales 92726.94 but aggregate_data returned 92000.00.',
    });
  });

  it('fails Case 3 when South has the wrong order count', async () => {
    const rows = completeRegionalRows();
    rows[1] = ['South', 92726.94, 39];
    const result = await evaluateTopRegion([
      aggregateDataResult(rows),
      assistantMessage('销售额最高的是 South，销售额合计为 92,726.94，共 39 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'Expected South order count 40 but aggregate_data returned 39.',
    });
  });

  it('fails Case 3 when another region has a higher sales total', async () => {
    const rows = completeRegionalRows();
    rows[3] = ['West', 100000, 34];
    const result = await evaluateTopRegion([
      aggregateDataResult(rows),
      assistantMessage('销售额最高的是 South，销售额合计为 92,726.94，共 40 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'South had the expected sales total, but another region had a higher total.',
    });
  });

  it('fails Case 3 when aggregate_data rows are truncated', async () => {
    const result = await evaluateTopRegion([
      aggregateDataResult(completeRegionalRows().slice(0, 2), {
        resultRowCount: 4,
        returnedRowCount: 2,
        truncated: true,
      }),
      assistantMessage('销售额最高的是 South，销售额合计为 92,726.94，共 40 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'aggregate_data result was truncated, so the highest-sales region cannot be verified deterministically.',
    });
  });

  it('fails Case 3 when the final answer reports the wrong region', async () => {
    const result = await evaluateTopRegion([
      aggregateDataResult(),
      assistantMessage('销售额最高的是 North，销售额合计为 92,726.94，共 40 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'The aggregate result was correct, but the final assistant answer did not report the expected top region and metrics together.',
    });
  });

  it('fails Case 3 when the final answer reports the wrong amount', async () => {
    const result = await evaluateTopRegion([
      aggregateDataResult(),
      assistantMessage('销售额最高的是 South，销售额合计为 92,700，共 40 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'The aggregate result was correct, but the final assistant answer did not report the expected top region and metrics together.',
    });
  });

  it('fails Case 3 when the final answer reports the wrong order count', async () => {
    const result = await evaluateTopRegion([
      aggregateDataResult(),
      assistantMessage('销售额最高的是 South，销售额合计为 92,726.94，共 39 笔订单。'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'The aggregate result was correct, but the final assistant answer did not report the expected top region and metrics together.',
    });
  });

  it.each(['92726.94', '92,726.94'])(
    'accepts the supported amount format %s in the final answer',
    async (amount) => {
      const result = await evaluateTopRegion([
        aggregateDataResult(),
        assistantMessage(`SalesData: South has the highest sales, total sales ${amount}, 40 orders.`),
      ]);

      expect(result.passed).toBe(true);
      expect(result.score).toBe(1);
    },
  );

  it('accepts a compact region, sales, and order-count answer', async () => {
    const result = await evaluateTopRegion([
      aggregateDataResult(),
      assistantMessage('South / 92,726.94 / 40'),
    ]);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });
});

function completedRun(caseId = 'excel-sheet-count-001'): EvalRunResult<ExecuteTurnResult> {
  return { caseId, status: 'completed', durationMs: 1 };
}

async function evaluateRows(messages: readonly ExecuteTurnResult['messages'][number][]) {
  return evaluator.evaluate({
    expected: rowCountExpected,
    actual: turnResult(messages),
    run: completedRun('excel-sheet-row-counts-002'),
  });
}

async function evaluateTopRegion(messages: readonly ExecuteTurnResult['messages'][number][]) {
  return evaluator.evaluate({
    expected: topRegionSalesExpected,
    actual: turnResult(messages),
    run: completedRun('excel-top-region-sales-003'),
  });
}

function turnResult(messages: readonly ExecuteTurnResult['messages'][number][]): ExecuteTurnResult {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    leafId: 'leaf-1',
    messages,
  };
}

function workbookInfoResult(sheetCount: number, isError = false): ToolResultMessage {
  return {
    role: 'tool',
    callId: 'workbook-call',
    name: 'get_workbook_info',
    content: [{ type: 'text', text: `sheetCount: ${sheetCount}` }],
    details: { sheetCount },
    isError,
  };
}

function sheetProfileResult(
  sheetName: string,
  rowCount: number,
  isError = false,
): ToolResultMessage {
  return {
    role: 'tool',
    callId: `profile-${sheetName}`,
    name: 'get_sheet_profile',
    content: [{ type: 'text', text: `sheetName: ${sheetName}\nrowCount: ${rowCount}` }],
    details: { sheetName, rowCount },
    isError,
  };
}

function aggregateDataResult(
  rows: readonly (readonly unknown[])[] = completeRegionalRows(),
  options: {
    readonly isError?: boolean;
    readonly resultRowCount?: number;
    readonly returnedRowCount?: number;
    readonly truncated?: boolean;
  } = {},
): ToolResultMessage {
  return {
    role: 'tool',
    callId: 'aggregate-call',
    name: 'aggregate_data',
    content: [{ type: 'text', text: 'display text is not used for correctness' }],
    details: {
      sheetName: 'SalesData',
      columns: [
        { name: 'Region', kind: 'group', sourceColumn: 'Region' },
        { name: 'salesSum', kind: 'metric', sourceColumn: 'Revenue', operation: 'sum' },
        { name: 'orders', kind: 'metric', sourceColumn: 'OrderID', operation: 'count' },
      ],
      rows,
      sourceRowCount: 120,
      resultRowCount: options.resultRowCount ?? rows.length,
      returnedRowCount: options.returnedRowCount ?? rows.length,
      truncated: options.truncated ?? false,
    },
    isError: options.isError ?? false,
  };
}

function completeRegionalRows(): (string | number)[][] {
  return [
    ['North', 56067.46, 25],
    ['South', 92726.94, 40],
    ['East', 38655.38, 21],
    ['West', 58213.99, 34],
  ];
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    content: [{ type: 'text', text }],
    finishReason: 'stop',
  };
}
