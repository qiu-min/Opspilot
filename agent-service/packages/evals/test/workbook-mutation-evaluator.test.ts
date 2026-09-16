import { Turn, type ToolCompletedEvent, type TurnEvent } from '@opspilot/application';
import { describe, expect, it } from 'vitest';

import type { EvalRunResult } from '../src/core/eval-run-result.js';
import {
  WorkbookMutationEvaluator,
  type DurableTurnReader,
  type WorkbookMutationReader,
} from '../src/index.js';

const expected = {
  workbookMutation: {
    sheetName: 'MonthlySummary',
    range: 'H2',
    expectedValues: [['Verified']],
  },
};

describe('WorkbookMutationEvaluator', () => {
  it('passes only when durable write evidence and final workbook values are correct', async () => {
    const result = await evaluate([toolCompleted(false)], [['Verified']]);

    expect(result).toMatchObject({
      evaluator: 'workbook_mutation',
      score: 1,
      passed: true,
      details: {
        turnId: 'turn-1',
        sheetName: 'MonthlySummary',
        range: 'H2',
        expectedValues: [['Verified']],
        actualValues: [['Verified']],
        writeCallId: 'write-call-1',
      },
    });
  });

  it('fails when durable write_data evidence is missing', async () => {
    const result = await evaluate([], [['Verified']]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'write_data was not completed in durable Turn evidence.',
      details: { kind: 'missing_write_tool' },
    });
  });

  it('fails when every durable write_data completion is an error', async () => {
    const result = await evaluate([toolCompleted(true)], [['Verified']]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'All durable write_data completions were errors.',
      details: { kind: 'write_tool_failed' },
    });
  });

  it('fails when write_data succeeded but the final workbook value is wrong', async () => {
    const result = await evaluate([toolCompleted(false)], [['Not verified']]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'The final working workbook values did not match expectedValues.',
      details: { kind: 'value_mismatch', actualValues: [['Not verified']] },
    });
  });

  it('distinguishes a missing working resource from a workbook read failure', async () => {
    const missing = await evaluate([toolCompleted(false)], null);
    const readFailure = await evaluate([toolCompleted(false)], new Error('invalid workbook'));

    expect(missing).toMatchObject({
      score: 0,
      passed: false,
      details: { kind: 'missing_working_resource' },
    });
    expect(readFailure).toMatchObject({
      score: 0,
      passed: false,
      details: { kind: 'workbook_read_failed' },
    });
  });

  it('skips cases without a workbookMutation expectation', async () => {
    const turns = createTurnsReader([]);
    const workbook: WorkbookMutationReader = {
      readRange: async () => {
        throw new Error('must not read');
      },
    };
    const result = await new WorkbookMutationEvaluator({ turns, workbook }).evaluate({
      expected: { sheetCount: 3 },
      actual: undefined,
      run: completedRun(),
    });

    expect(result).toMatchObject({
      evaluator: 'workbook_mutation',
      score: 1,
      passed: true,
      details: { kind: 'skipped' },
    });
  });

  it('fails closed for an invalid workbookMutation expectation', async () => {
    const turns = createTurnsReader([]);
    const workbook: WorkbookMutationReader = {
      readRange: async () => [['Verified']],
    };
    const result = await new WorkbookMutationEvaluator({ turns, workbook }).evaluate({
      expected: { workbookMutation: { sheetName: 'MonthlySummary' } },
      actual: undefined,
      run: completedRun(),
    });

    expect(result).toMatchObject({
      evaluator: 'workbook_mutation',
      score: 0,
      passed: false,
      reason: 'expected.workbookMutation is invalid.',
      details: { kind: 'invalid_expected_contract' },
    });
  });
});

async function evaluate(
  events: readonly TurnEvent[],
  values: readonly (readonly unknown[])[] | null | Error,
) {
  const turns = createTurnsReader(events);
  const workbook: WorkbookMutationReader = {
    readRange: async () => {
      if (values instanceof Error) throw values;
      return values;
    },
  };
  return await new WorkbookMutationEvaluator({ turns, workbook }).evaluate({
    expected,
    actual: undefined,
    run: completedRun(),
  });
}

function createTurnsReader(events: readonly TurnEvent[]): DurableTurnReader {
  const turn = Turn.create({
    id: 'turn-1',
    sessionId: 'session-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  turn.start('2026-01-01T00:00:00.000Z');
  return {
    load: (turnId) => {
      if (turnId !== 'turn-1') throw new Error(`Unknown Turn ${turnId}.`);
      return turn;
    },
    loadEvents: (turnId) => {
      if (turnId !== 'turn-1') throw new Error(`Unknown Turn ${turnId}.`);
      return events;
    },
  };
}

function completedRun(): EvalRunResult<never> {
  return {
    caseId: 'excel-write-case',
    status: 'completed',
    durationMs: 1,
    metadata: {
      turnId: 'turn-1',
      sessionId: 'session-1',
      excelResourceId: 'excel-sales-workbook',
    },
  };
}

function toolCompleted(isError: boolean): ToolCompletedEvent {
  return {
    version: 2,
    id: `event-${isError ? 'error' : 'success'}`,
    turnId: 'turn-1',
    sessionId: 'session-1',
    sequence: 0,
    attempt: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'tool_completed',
    callId: 'write-call-1',
    name: 'write_data',
    isError,
    resultEntryId: 'entry-1',
    sessionLeafId: 'entry-1',
  };
}
