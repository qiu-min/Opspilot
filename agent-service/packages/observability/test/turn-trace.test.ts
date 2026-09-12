import { describe, expect, it } from 'vitest';

import type { TurnEvent } from '@opspilot/domain';

import { projectTurnTrace, type ToolTraceSpan } from '../src/index.js';

const turnId = 'turn-1';
const sessionId = 'session-1';

describe('projectTurnTrace', () => {
  it('projects Model → Tool → Model in durable execution order', () => {
    const events: TurnEvent[] = [
      turnStarted(0),
      modelStarted(1, 'model-call-A'),
      modelCompleted(2, 'model-call-A'),
      usage(3, 'model-call-A', 10, 20, 30),
      toolRequested(4, 'tool-call-X', 'lookup'),
      toolStarted(5, 'tool-call-X', 'lookup'),
      toolCompleted(6, 'tool-call-X', 'lookup', false),
      modelStarted(7, 'model-call-B'),
      usage(8, 'model-call-B', 40, 50, 90),
      modelCompleted(9, 'model-call-B'),
      turnCompleted(10),
    ];

    const trace = projectTurnTrace(events);

    expect(trace).toMatchObject({
      turnId,
      sessionId,
      status: 'completed',
      startedAt: timestamp(0),
      endedAt: timestamp(10),
      durationMs: 10_000,
    });
    expect(trace.spans.map((span) => span.id)).toEqual([
      'model:model-call-A',
      'tool:tool-call-X:attempt:1',
      'model:model-call-B',
    ]);
    expect(trace.spans[0]).toMatchObject({
      kind: 'model',
      modelCallId: 'model-call-A',
      attempt: 1,
      status: 'completed',
      startSequence: 1,
      endSequence: 2,
      startedAt: timestamp(1),
      endedAt: timestamp(2),
      durationMs: 1_000,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    expect(trace.spans[1]).toMatchObject({
      kind: 'tool',
      callId: 'tool-call-X',
      name: 'lookup',
      attempt: 1,
      status: 'completed',
      startSequence: 5,
      endSequence: 6,
      requestedAt: timestamp(4),
      startedAt: timestamp(5),
      endedAt: timestamp(6),
      durationMs: 1_000,
      isError: false,
    });
    expect(trace.spans[2]).toMatchObject({
      kind: 'model',
      modelCallId: 'model-call-B',
      usage: { inputTokens: 40, outputTokens: 50, totalTokens: 90 },
    });
  });

  it('projects a Turn containing only one completed model call', () => {
    const trace = projectTurnTrace([
      turnStarted(0),
      modelStarted(1, 'model-call-A'),
      modelCompleted(2, 'model-call-A'),
      usage(3, 'model-call-A', 1, 2, 3),
      turnCompleted(4),
    ]);

    expect(trace.status).toBe('completed');
    expect(trace.spans).toHaveLength(1);
    expect(trace.spans[0]).toMatchObject({ id: 'model:model-call-A', status: 'completed' });
  });

  it('keeps a model span incomplete when its completion is missing', () => {
    const trace = projectTurnTrace([turnStarted(0), modelStarted(1, 'model-call-A')]);

    expect(trace.status).toBe('running');
    expect(trace.endedAt).toBeNull();
    expect(trace.durationMs).toBeNull();
    expect(trace.spans[0]).toMatchObject({
      id: 'model:model-call-A',
      status: 'incomplete',
      startedAt: timestamp(1),
      endedAt: null,
      durationMs: null,
    });
  });

  it('keeps a tool span incomplete when execution has not completed', () => {
    const trace = projectTurnTrace([
      turnStarted(0),
      toolRequested(1, 'tool-call-X', 'lookup'),
      toolStarted(2, 'tool-call-X', 'lookup'),
    ]);

    expect(trace.spans[0]).toMatchObject({
      id: 'tool:tool-call-X:attempt:1',
      status: 'incomplete',
      startSequence: 2,
      requestedAt: timestamp(1),
      startedAt: timestamp(2),
      endedAt: null,
      durationMs: null,
      isError: false,
    });
  });

  it('projects retry-safe Tool executions as separate attempt spans', () => {
    const trace = projectTurnTrace([
      turnStarted(0, 1),
      toolRequested(1, 'tool-call-X', 'lookup', 1),
      toolStarted(2, 'tool-call-X', 'lookup', 1),
      turnResumed(3, 2),
      toolStarted(4, 'tool-call-X', 'lookup', 2),
      toolCompleted(5, 'tool-call-X', 'lookup', false, 2),
    ]);

    expect(trace.spans).toHaveLength(2);
    expect(trace.spans[0]).toMatchObject({
      id: 'tool:tool-call-X:attempt:1',
      callId: 'tool-call-X',
      attempt: 1,
      status: 'incomplete',
      startedAt: timestamp(2),
      endedAt: null,
      durationMs: null,
    });
    expect(trace.spans[1]).toMatchObject({
      id: 'tool:tool-call-X:attempt:2',
      callId: 'tool-call-X',
      attempt: 2,
      status: 'completed',
      requestedAt: null,
      startedAt: timestamp(4),
      endedAt: timestamp(5),
      durationMs: 1_000,
    });
    const toolSpans = trace.spans.filter((span): span is ToolTraceSpan => span.kind === 'tool');
    expect(toolSpans[0]?.callId).toBe(toolSpans[1]?.callId);
    expect(toolSpans[0]?.attempt).not.toBe(toolSpans[1]?.attempt);
    expect(toolSpans[0]?.id).not.toBe(toolSpans[1]?.id);
  });

  it('pairs serial compaction events and preserves completion metadata', () => {
    const trace = projectTurnTrace([
      turnStarted(0),
      compactionStarted(1),
      compactionCompleted(2, 'entry-1', 'leaf-1'),
      turnCompleted(3),
    ]);

    expect(trace.spans).toEqual([
      {
        id: 'compaction:1',
        kind: 'compaction',
        attempt: 1,
        status: 'completed',
        startSequence: 1,
        endSequence: 2,
        startedAt: timestamp(1),
        endedAt: timestamp(2),
        durationMs: 1_000,
        entryId: 'entry-1',
        sessionLeafId: 'leaf-1',
      },
    ]);
  });

  it('keeps a compaction span incomplete when its completion is missing', () => {
    const trace = projectTurnTrace([turnStarted(0), compactionStarted(1)]);

    expect(trace.spans[0]).toMatchObject({
      id: 'compaction:1',
      kind: 'compaction',
      status: 'incomplete',
      startedAt: timestamp(1),
      endedAt: null,
      durationMs: null,
    });
  });

  it('pairs compaction completion only with an open compaction in the same attempt', () => {
    const trace = projectTurnTrace([
      turnStarted(0, 1),
      compactionStarted(1, 1),
      turnResumed(2, 2),
      compactionStarted(3, 2),
      compactionCompleted(4, undefined, undefined, 2),
    ]);

    expect(trace.spans).toMatchObject([
      { id: 'compaction:1', attempt: 1, status: 'incomplete', endSequence: null },
      { id: 'compaction:3', attempt: 2, status: 'completed', endSequence: 4 },
    ]);
  });

  it('keeps model calls from different recovery attempts separate', () => {
    const trace = projectTurnTrace([
      turnStarted(0, 1),
      modelStarted(1, 'model-call-A', 1),
      modelStarted(2, 'model-call-B', 2),
      modelCompleted(3, 'model-call-B', 2),
      usage(4, 'model-call-B', 2, 3, 5),
    ]);

    expect(trace.spans).toMatchObject([
      { id: 'model:model-call-A', attempt: 1, status: 'incomplete' },
      { id: 'model:model-call-B', attempt: 2, status: 'completed' },
    ]);
  });

  it('represents tool errors without losing execution duration', () => {
    const trace = projectTurnTrace([
      toolStarted(0, 'tool-call-X', 'lookup'),
      toolCompleted(1, 'tool-call-X', 'lookup', true),
    ]);

    expect(trace.spans[0]).toMatchObject({
      status: 'error',
      isError: true,
      durationMs: 1_000,
    });
  });

  it('sorts input by durable sequence and accepts usage before completion', () => {
    const ordered: TurnEvent[] = [
      turnStarted(0),
      modelStarted(1, 'model-call-A'),
      usage(2, 'model-call-A', 1, 2, 3),
      modelCompleted(3, 'model-call-A'),
      turnCompleted(4),
    ];
    const reversed = [...ordered].reverse();

    expect(projectTurnTrace(reversed)).toEqual(projectTurnTrace(ordered));
    expect(projectTurnTrace(reversed).spans[0]).toMatchObject({
      status: 'completed',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
  });

  it('does not throw for terminal events without a matching start', () => {
    const trace = projectTurnTrace([
      turnStarted(0),
      modelCompleted(1, 'model-call-A'),
      toolCompleted(2, 'tool-call-X', 'lookup', false),
      turnFailed(3, 'provider failed'),
    ]);

    expect(trace.status).toBe('failed');
    expect(trace.spans).toMatchObject([
      {
        id: 'model:model-call-A',
        status: 'incomplete',
        startedAt: null,
        endedAt: timestamp(1),
        durationMs: null,
      },
      {
        id: 'tool:tool-call-X:attempt:1',
        status: 'incomplete',
        startedAt: null,
        endedAt: timestamp(2),
        durationMs: null,
      },
    ]);
  });

  it('keeps the first completion when duplicate terminal facts exist', () => {
    const trace = projectTurnTrace([
      modelStarted(0, 'model-call-A'),
      modelCompleted(1, 'model-call-A'),
      modelCompleted(2, 'model-call-A'),
    ]);

    expect(trace.spans[0]).toMatchObject({ endSequence: 1, endedAt: timestamp(1) });
  });
});

function turnStarted(sequence: number, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'turn_started',
  };
}

function turnCompleted(sequence: number, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'turn_completed',
    resultLeafId: null,
  };
}

function turnFailed(sequence: number, message: string, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'turn_failed',
    message,
  };
}

function turnResumed(sequence: number, attempt: number): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'turn_resumed',
  };
}

function modelStarted(sequence: number, modelCallId: string, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'model_started',
    modelCallId,
  };
}

function modelCompleted(sequence: number, modelCallId: string, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'model_completed',
    modelCallId,
  };
}

function usage(
  sequence: number,
  modelCallId: string,
  inputTokens: number,
  outputTokens: number,
  totalTokens: number,
  attempt = 1,
): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'usage_recorded',
    modelCallId,
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function toolRequested(sequence: number, callId: string, name: string, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'tool_requested',
    callId,
    name,
  };
}

function toolStarted(sequence: number, callId: string, name: string, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'tool_started',
    callId,
    name,
  };
}

function toolCompleted(
  sequence: number,
  callId: string,
  name: string,
  isError: boolean,
  attempt = 1,
): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'tool_completed',
    callId,
    name,
    isError,
    resultEntryId: `result-${callId}`,
    sessionLeafId: `leaf-${callId}`,
  };
}

function compactionStarted(sequence: number, attempt = 1): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'compaction_started',
  };
}

function compactionCompleted(
  sequence: number,
  entryId: string | undefined,
  sessionLeafId: string | undefined,
  attempt = 1,
): TurnEvent {
  return {
    ...baseEvent(sequence, attempt),
    type: 'compaction_completed',
    ...(entryId === undefined ? {} : { entryId }),
    ...(sessionLeafId === undefined ? {} : { sessionLeafId }),
  };
}

function baseEvent(sequence: number, attempt: number): Omit<TurnEvent, 'type'> {
  return {
    version: 2,
    id: `event-${sequence}`,
    turnId,
    sessionId,
    sequence,
    attempt,
    timestamp: timestamp(sequence),
  };
}

function timestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
}
