import type { ExecuteTurnResult } from '@opspilot/application';
import type { AssistantMessage, ToolResultMessage } from '@opspilot/model-gateway';
import { describe, expect, it } from 'vitest';

import type { EvalRunResult } from '../src/core/eval-run-result.js';
import { ExcelWorkbookCorrectnessEvaluator } from '../src/evaluators/excel-workbook-correctness-evaluator.js';

const evaluator = new ExcelWorkbookCorrectnessEvaluator();
const expected = { sheetCount: 3 };

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
});

function completedRun(): EvalRunResult<ExecuteTurnResult> {
  return { caseId: 'excel-sheet-count-001', status: 'completed', durationMs: 1 };
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
