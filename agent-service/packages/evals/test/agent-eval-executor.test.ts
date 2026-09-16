import { describe, expect, it } from 'vitest';

import { AgentEvalExecutor } from '../src/executors/agent-eval-executor.js';
import type { ExecuteTurnInput, ExecuteTurnResult } from '@opspilot/application';

const success: ExecuteTurnResult = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  leafId: 'leaf-1',
  messages: [
    {
      role: 'assistant',
      api: 'test',
      provider: 'test',
      model: 'test',
      content: [],
      finishReason: 'stop',
    },
  ],
};

describe('AgentEvalExecutor', () => {
  it('adapts a prompt and preserves Application execution metadata', async () => {
    let receivedMessage: unknown;
    const executor = new AgentEvalExecutor({
      executeTurn: {
        execute: async (input) => {
          receivedMessage = input.message;
          return success;
        },
      },
    });

    const result = await executor.execute({ id: 'case-1', name: 'Case 1', input: 'hello' });

    expect(receivedMessage).toEqual({ role: 'user', content: [{ type: 'text', text: 'hello' }] });
    expect(result).toMatchObject({
      caseId: 'case-1',
      status: 'completed',
      actual: success,
      metadata: { sessionId: 'session-1', turnId: 'turn-1', leafId: 'leaf-1' },
    });
  });

  it('converts an Application execution throw into an error result', async () => {
    const executor = new AgentEvalExecutor({
      executeTurn: {
        execute: async () => {
          throw new Error('gateway unavailable');
        },
      },
    });

    const result = await executor.execute({ id: 'case-1', name: 'Case 1', input: 'hello' });

    expect(result).toMatchObject({
      caseId: 'case-1',
      status: 'error',
      error: { message: 'gateway unavailable' },
    });
  });

  it('passes an attached Excel resource through to Application ExecuteTurn', async () => {
    let receivedInput: ExecuteTurnInput | undefined;
    const executor = new AgentEvalExecutor({
      executeTurn: {
        execute: async (input) => {
          receivedInput = input;
          return success;
        },
      },
    });

    const result = await executor.execute({
      id: 'excel-case-1',
      name: 'Excel Case 1',
      input: {
        message: 'How many worksheets are there?',
        excelResource: { id: 'excel-sales-workbook', filePath: '/fixtures/sales.xlsx' },
      },
    });

    expect(receivedInput).toMatchObject({
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'How many worksheets are there?' }],
      },
      excelResource: { id: 'excel-sales-workbook', filePath: '/fixtures/sales.xlsx' },
    });
    expect(result.metadata).toMatchObject({ excelResourceId: 'excel-sales-workbook' });
  });
});
