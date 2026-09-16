import type {
  CompactionTraceSpan,
  ModelTraceSpan,
  ToolTraceSpan,
  TurnTrace,
} from '@opspilot/application';
import { describe, expect, it, vi } from 'vitest';

import type { EvalRunResult } from '../src/core/eval-run-result.js';
import { TraceBehaviorEvaluator } from '../src/evaluators/trace-behavior-evaluator.js';

describe('TraceBehaviorEvaluator', () => {
  it('passes when every required tool completed successfully', async () => {
    const score = await evaluate([toolSpan('aggregate_data')], {
      requiredTools: ['aggregate_data'],
    });

    expect(score).toMatchObject({ evaluator: 'trace_behavior', score: 1, passed: true });
  });

  it('fails when a required tool is absent', async () => {
    const score = await evaluate([], { requiredTools: ['aggregate_data'] });

    expect(score).toMatchObject({
      evaluator: 'trace_behavior',
      score: 0,
      passed: false,
      reason: 'Required tool aggregate_data did not complete successfully.',
    });
  });

  it('fails when a required tool exists but errored', async () => {
    const score = await evaluate([toolSpan('aggregate_data', 'error', true)], {
      requiredTools: ['aggregate_data'],
    });

    expect(score.passed).toBe(false);
    expect(score.reason).toBe('Required tool aggregate_data did not complete successfully.');
  });

  it('passes when a forbidden tool was not executed', async () => {
    const score = await evaluate([], { forbiddenTools: ['write_data'] });

    expect(score).toMatchObject({ evaluator: 'trace_behavior', score: 1, passed: true });
  });

  it('fails when a forbidden tool completed successfully', async () => {
    const score = await evaluate([toolSpan('write_data')], { forbiddenTools: ['write_data'] });

    expect(score.reason).toBe('Forbidden tool write_data was executed.');
    expect(score.passed).toBe(false);
  });

  it('fails when a forbidden tool executed and errored', async () => {
    const score = await evaluate([toolSpan('write_data', 'error', true)], {
      forbiddenTools: ['write_data'],
    });

    expect(score.reason).toBe('Forbidden tool write_data was executed.');
    expect(score.passed).toBe(false);
  });

  it('fails when tool errors exceed maxToolErrors', async () => {
    const score = await evaluate([toolSpan('aggregate_data', 'error', true)], {
      maxToolErrors: 0,
    });

    expect(score.reason).toBe('Expected at most 0 tool errors but Trace contained 1.');
    expect(score.passed).toBe(false);
  });

  it('collects model, tool, retry, compaction, and token metrics', async () => {
    const score = await evaluate([
      modelSpan('model-1', { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, 1),
      toolSpan('get_sheet_profile'),
      modelSpan('model-2', { inputTokens: 200, outputTokens: 30, totalTokens: 230 }),
      toolSpan('aggregate_data'),
      toolSpan('aggregate_data'),
      compactionSpan(),
    ]);

    expect(score.details).toMatchObject({
      modelCalls: 2,
      toolCalls: 3,
      toolErrors: 0,
      retries: 1,
      compactions: 1,
      inputTokens: 300,
      outputTokens: 50,
      totalTokens: 350,
      durationMs: 123,
    });
  });

  it('deduplicates usedTools while preserving first appearance order', async () => {
    const score = await evaluate([
      toolSpan('get_sheet_profile'),
      toolSpan('aggregate_data'),
      toolSpan('aggregate_data'),
    ]);

    expect(score.details).toMatchObject({
      usedTools: ['get_sheet_profile', 'aggregate_data'],
      toolCalls: 3,
    });
  });

  it('fails when the run does not expose a non-empty turnId', async () => {
    const reader = { execute: vi.fn(() => trace([])) };
    const evaluator = new TraceBehaviorEvaluator({ getTurnTrace: reader });
    const score = await evaluator.evaluate({
      expected: undefined,
      actual: undefined,
      run: run({ turnId: '  ' }),
    });

    expect(score).toMatchObject({
      evaluator: 'trace_behavior',
      score: 0,
      passed: false,
      reason: 'Eval run did not expose a valid turnId for Trace evaluation.',
    });
    expect(reader.execute).not.toHaveBeenCalled();
  });

  it('passes without behavior constraints while still returning metrics', async () => {
    const score = await evaluate([modelSpan('model-1')]);

    expect(score).toMatchObject({ evaluator: 'trace_behavior', score: 1, passed: true });
    expect(score.details).toMatchObject({ modelCalls: 1, toolCalls: 0, totalTokens: 0 });
  });
});

async function evaluate(
  spans: readonly (ModelTraceSpan | ToolTraceSpan | CompactionTraceSpan)[],
  behavior?: {
    readonly requiredTools?: readonly string[];
    readonly forbiddenTools?: readonly string[];
    readonly maxToolErrors?: number;
  },
) {
  const reader = { execute: vi.fn(() => trace(spans)) };
  const evaluator = new TraceBehaviorEvaluator({ getTurnTrace: reader });
  return await evaluator.evaluate({
    expected: behavior === undefined ? undefined : { behavior },
    actual: undefined,
    run: run({ turnId: 'turn-1' }),
  });
}

function run(metadata?: Readonly<Record<string, unknown>>): EvalRunResult<never> {
  return {
    caseId: 'trace-case',
    status: 'completed',
    durationMs: 123,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function trace(
  spans: readonly (ModelTraceSpan | ToolTraceSpan | CompactionTraceSpan)[],
): TurnTrace {
  return {
    turnId: 'turn-1',
    sessionId: 'session-1',
    status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:00:00.123Z',
    durationMs: 123,
    spans,
  };
}

function toolSpan(
  name: string,
  status: ToolTraceSpan['status'] = 'completed',
  isError = false,
): ToolTraceSpan {
  return {
    id: `tool:${name}`,
    kind: 'tool',
    callId: `call:${name}`,
    name,
    attempt: 1,
    status,
    startSequence: 1,
    endSequence: 2,
    startedAt: '2026-01-01T00:00:00.001Z',
    endedAt: '2026-01-01T00:00:00.002Z',
    durationMs: 1,
    requestedAt: '2026-01-01T00:00:00.000Z',
    isError,
  };
}

function modelSpan(
  modelCallId: string,
  usage: ModelTraceSpan['usage'] = null,
  retryCount = 0,
): ModelTraceSpan {
  return {
    id: `model:${modelCallId}`,
    kind: 'model',
    modelCallId,
    attempt: 1,
    status: 'completed',
    startSequence: 1,
    endSequence: 2,
    startedAt: '2026-01-01T00:00:00.001Z',
    endedAt: '2026-01-01T00:00:00.002Z',
    durationMs: 1,
    usage,
    error: null,
    retries: Array.from({ length: retryCount }, (_, index) => ({
      failedAttempt: index + 1,
      nextAttempt: index + 2,
      delayMs: 10,
      error: {
        kind: 'timeout' as const,
        code: 'timeout',
        message: 'temporary timeout',
        retryable: true,
      },
      timestamp: '2026-01-01T00:00:00.003Z',
    })),
  };
}

function compactionSpan(): CompactionTraceSpan {
  return {
    id: 'compaction:1',
    kind: 'compaction',
    attempt: 1,
    status: 'completed',
    startSequence: 1,
    endSequence: 2,
    startedAt: '2026-01-01T00:00:00.001Z',
    endedAt: '2026-01-01T00:00:00.002Z',
    durationMs: 1,
  };
}
