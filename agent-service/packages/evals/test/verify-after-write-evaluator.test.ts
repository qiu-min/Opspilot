import { Turn, type ToolCompletedEvent, type TurnEvent } from '@opspilot/application';
import { describe, expect, it } from 'vitest';

import type { EvalRunResult } from '../src/core/eval-run-result.js';
import {
  VerifyAfterWriteEvaluator,
  type DurableTurnReader,
} from '../src/index.js';

const expected = {
  workbookMutation: {
    sheetName: 'MonthlySummary',
    range: 'H2',
    expectedValues: [['Verified']],
  },
  behavior: { verifyAfterWrite: true },
};

describe('VerifyAfterWriteEvaluator', () => {
  it('passes when a successful target write is followed by a matching read', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2' }),
      toolCompleted('read_range', 20, { sheetName: 'MonthlySummary', range: 'H2' }, 'read-call-1'),
    ]);

    expect(result).toMatchObject({
      evaluator: 'verify_after_write',
      score: 1,
      passed: true,
      details: {
        writeCallId: 'write_data-call-1',
        writeSequence: 10,
        writeSheetName: 'MonthlySummary',
        writeRange: 'H2',
        readCallId: 'read-call-1',
        readSequence: 20,
        readSheetName: 'MonthlySummary',
        readRange: 'H2',
      },
    });
  });

  it('passes when the verification read covers a larger range', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2:I3' }),
      toolCompleted('read_range', 20, { sheetName: 'MonthlySummary', range: 'G1:J4' }, 'read-call-1'),
    ], {
      workbookMutation: {
        sheetName: 'MonthlySummary',
        range: 'H2:I3',
        expectedValues: [['A', 'B'], ['C', 'D']],
      },
      behavior: { verifyAfterWrite: true },
    });

    expect(result).toMatchObject({ evaluator: 'verify_after_write', score: 1, passed: true });
  });

  it('fails when no read_range occurs after the target write', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2' }),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      details: { kind: 'missing_verification_read' },
    });
  });

  it('does not count a read_range that occurred before the write', async () => {
    const result = await evaluate([
      toolCompleted('read_range', 10, { sheetName: 'MonthlySummary', range: 'H2' }, 'read-call-1'),
      toolCompleted('write_data', 20, { sheetName: 'MonthlySummary', range: 'H2' }),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      details: { kind: 'missing_verification_read' },
    });
  });

  it('fails when the read is on a different sheet', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2' }),
      toolCompleted('read_range', 20, { sheetName: 'SalesData', range: 'H2' }, 'read-call-1'),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      details: { kind: 'verification_range_mismatch' },
    });
  });

  it('fails when the read range does not cover the written range', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2:I3' }),
      toolCompleted('read_range', 20, { sheetName: 'MonthlySummary', range: 'H2:H3' }, 'read-call-1'),
    ], {
      workbookMutation: {
        sheetName: 'MonthlySummary',
        range: 'H2:I3',
        expectedValues: [['A', 'B'], ['C', 'D']],
      },
      behavior: { verifyAfterWrite: true },
    });

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      details: { kind: 'verification_range_mismatch' },
    });
  });

  it('fails when the read_range completion is an error', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2' }),
      toolCompleted('read_range', 20, { sheetName: 'MonthlySummary', range: 'H2' }, 'read-call-1', true),
    ]);

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      details: { kind: 'verification_read_failed' },
    });
  });

  it('continues past a mismatched read when a later read covers the target', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2' }),
      toolCompleted('read_range', 20, { sheetName: 'SalesData', range: 'A1' }, 'read-call-1'),
      toolCompleted('read_range', 30, { sheetName: 'MonthlySummary', range: 'H1:H3' }, 'read-call-2'),
    ]);

    expect(result).toMatchObject({
      evaluator: 'verify_after_write',
      score: 1,
      passed: true,
      details: { readCallId: 'read-call-2', readSequence: 30, readRange: 'H1:H3' },
    });
  });

  it('uses the last successful write matching the expected target', async () => {
    const result = await evaluate([
      toolCompleted('write_data', 10, { sheetName: 'MonthlySummary', range: 'H2' }, 'write-call-1'),
      toolCompleted('write_data', 20, { sheetName: 'SalesData', range: 'A1' }, 'write-call-2'),
      toolCompleted('write_data', 30, { sheetName: 'MonthlySummary', range: 'H2' }, 'write-call-3'),
      toolCompleted('read_range', 40, { sheetName: 'MonthlySummary', range: 'H2' }, 'read-call-1'),
    ]);

    expect(result).toMatchObject({
      score: 1,
      passed: true,
      details: { writeCallId: 'write-call-3', writeSequence: 30 },
    });
  });

  it('skips non-mutation cases', async () => {
    const result = await evaluate([], { sheetCount: 3 });

    expect(result).toMatchObject({
      evaluator: 'verify_after_write',
      score: 1,
      passed: true,
      details: { kind: 'skipped' },
    });
  });

  it('fails closed when verification is enabled without a valid mutation contract', async () => {
    const result = await evaluate([], { behavior: { verifyAfterWrite: true } });

    expect(result).toMatchObject({
      evaluator: 'verify_after_write',
      score: 0,
      passed: false,
      details: { kind: 'invalid_expected_contract' },
    });
  });
});

async function evaluate(
  events: readonly TurnEvent[],
  currentExpected: unknown = expected,
) {
  const evaluator = new VerifyAfterWriteEvaluator({ turns: createTurnsReader(events) });
  return await evaluator.evaluate({
    expected: currentExpected,
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
    metadata: { turnId: 'turn-1' },
  };
}

function toolCompleted(
  name: 'write_data' | 'read_range',
  sequence: number,
  rangeDetails: { readonly sheetName: string; readonly range: string },
  callId = `${name}-call-1`,
  isError = false,
): ToolCompletedEvent {
  return {
    version: 2,
    id: `event-${callId}`,
    turnId: 'turn-1',
    sessionId: 'session-1',
    sequence,
    attempt: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'tool_completed',
    callId,
    name,
    isError,
    resultEntryId: `entry-${callId}`,
    sessionLeafId: `entry-${callId}`,
    resultDetails: {
      sheetName: rangeDetails.sheetName,
      range: rangeDetails.range,
      ...(name === 'write_data' ? { message: 'Write completed.' } : { values: [['Verified']] }),
    },
  };
}
