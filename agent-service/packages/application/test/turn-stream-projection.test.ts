import { describe, expect, it } from 'vitest';

import {
  applyTurnStreamEvent,
  createInitialTurnStreamProjection,
  TurnStreamProjector,
  type AgentSessionEvent,
  type TurnStreamEvent,
  type TurnStreamEventDraftPayload,
} from '../src/index.js';

const identity = { turnId: 'turn-1', sessionId: 'session-1' };

describe('TurnStreamProjection reducer', () => {
  it('accumulates consecutive assistant text deltas', () => {
    let projection = createInitialTurnStreamProjection(identity);
    projection = reduce(projection, event({ type: 'assistant_text_delta', delta: 'hello' }, 0));
    projection = reduce(projection, event({ type: 'assistant_text_delta', delta: ' world' }, 1));

    expect(projection.assistant.text).toBe('hello world');
    expect(projection.lastSequence).toBe(1);
  });

  it('keeps only the current live assistant message across message boundaries', () => {
    let projection = createInitialTurnStreamProjection(identity);
    projection = reduce(projection, event({ type: 'assistant_message_started' }, 0));
    projection = reduce(projection, event({ type: 'assistant_text_delta', delta: 'first' }, 1));
    projection = reduce(projection, event({ type: 'assistant_message_completed' }, 2));
    expect(projection.assistant).toEqual({ text: '', messageVisible: false, isThinking: false });

    projection = reduce(projection, event({ type: 'assistant_message_started' }, 3));
    projection = reduce(projection, event({ type: 'assistant_text_delta', delta: 'second' }, 4));

    expect(projection.assistant).toEqual({
      text: 'second',
      messageVisible: true,
      isThinking: false,
    });
  });

  it('does not join assistant text across a tool round-trip', () => {
    let projection = createInitialTurnStreamProjection(identity);
    const events: TurnStreamEvent[] = [
      event({ type: 'assistant_message_started' }, 0),
      event({ type: 'assistant_text_delta', delta: 'checking' }, 1),
      event({ type: 'assistant_message_completed' }, 2),
      event({ type: 'tool_queued', callId: 'call-1', name: 'lookup' }, 3),
      event({ type: 'tool_started', callId: 'call-1', name: 'lookup' }, 4),
      event({ type: 'tool_completed', callId: 'call-1', name: 'lookup', isError: false }, 5),
      event({ type: 'assistant_message_started' }, 6),
      event({ type: 'assistant_text_delta', delta: 'result' }, 7),
    ];

    for (const next of events) projection = reduce(projection, next);

    expect(projection.assistant.text).toBe('result');
    expect(projection.tools).toEqual([{ callId: 'call-1', name: 'lookup', status: 'completed' }]);
  });

  it('tracks thinking, tools, compaction, usage, and terminal status', () => {
    let projection = createInitialTurnStreamProjection(identity);
    projection = reduce(projection, event({ type: 'assistant_thinking_started' }, 0));
    expect(projection.assistant.isThinking).toBe(true);
    projection = reduce(projection, event({ type: 'assistant_thinking_completed' }, 1));
    expect(projection.assistant.isThinking).toBe(false);

    projection = reduce(
      projection,
      event({ type: 'tool_queued', callId: 'call-1', name: 'lookup' }, 2),
    );
    projection = reduce(
      projection,
      event({ type: 'tool_started', callId: 'call-1', name: 'lookup' }, 3),
    );
    projection = reduce(
      projection,
      event({ type: 'tool_completed', callId: 'call-1', name: 'lookup', isError: true }, 4),
    );
    expect(projection.tools).toEqual([{ callId: 'call-1', name: 'lookup', status: 'failed' }]);

    projection = reduce(projection, event({ type: 'compaction_started', reason: 'threshold' }, 5));
    expect(projection.compaction.status).toBe('running');
    projection = reduce(
      projection,
      event({ type: 'compaction_completed', reason: 'threshold' }, 6),
    );
    expect(projection.compaction.status).toBe('idle');
    projection = reduce(
      projection,
      event({ type: 'usage', inputTokens: 10, outputTokens: 20, totalTokens: 30 }, 7),
    );
    expect(projection.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    projection = reduce(projection, event({ type: 'turn_completed', resultLeafId: 'leaf-1' }, 8));
    expect(projection.status).toBe('completed');
    expect(projection.lastSequence).toBe(8);
  });
});

describe('TurnStreamProjector', () => {
  it('maps reasoning to lifecycle markers without exposing reasoning text', () => {
    const projector = new TurnStreamProjector(identity);
    const thinking = projector.project({
      type: 'message_update',
      event: {
        type: 'thinking.delta',
        contentIndex: 0,
        delta: 'hidden reasoning',
        partial: assistantMessage(),
      },
      message: assistantMessage(),
    } satisfies AgentSessionEvent);
    const text = projector.project({
      type: 'message_update',
      event: {
        type: 'text.delta',
        contentIndex: 0,
        delta: 'visible',
        partial: assistantMessage(),
      },
      message: assistantMessage(),
    } satisfies AgentSessionEvent);

    expect(thinking.map((item) => item.type)).toEqual(['assistant_thinking_started']);
    expect(text.map((item) => item.type)).toEqual([
      'assistant_thinking_completed',
      'assistant_message_started',
      'assistant_text_delta',
    ]);
    expect(JSON.stringify([...thinking, ...text])).not.toContain('hidden reasoning');
  });
});

function reduce(
  projection: ReturnType<typeof createInitialTurnStreamProjection>,
  next: TurnStreamEvent,
): ReturnType<typeof createInitialTurnStreamProjection> {
  return applyTurnStreamEvent(projection, next);
}

function event(payload: TurnStreamEventDraftPayload, sequence: number): TurnStreamEvent {
  return {
    ...payload,
    ...identity,
    sequence,
    timestamp: new Date(sequence * 1_000).toISOString(),
  } as TurnStreamEvent;
}

function assistantMessage() {
  return {
    role: 'assistant' as const,
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    content: [],
    finishReason: 'pending' as const,
  };
}
