import { describe, expect, it, vi } from 'vitest';

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
      event({ type: 'tool_queued', callId: 'call-1', name: 'lookup', display: { title: 'Look up', subject: 'record-1' } }, 3),
      event({ type: 'tool_started', callId: 'call-1', name: 'lookup' }, 4),
      event({ type: 'tool_completed', callId: 'call-1', name: 'lookup', isError: false }, 5),
      event({ type: 'assistant_message_started' }, 6),
      event({ type: 'assistant_text_delta', delta: 'result' }, 7),
    ];

    for (const next of events) projection = reduce(projection, next);

    expect(projection.assistant.text).toBe('result');
    expect(projection.tools).toEqual([{ callId: 'call-1', name: 'lookup', display: { title: 'Look up', subject: 'record-1' }, status: 'completed', startedAt: new Date(4_000).toISOString(), completedAt: new Date(5_000).toISOString() }]);
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
    expect(projection.tools).toEqual([{ callId: 'call-1', name: 'lookup', status: 'failed', startedAt: new Date(3_000).toISOString(), completedAt: new Date(4_000).toISOString() }]);

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
    projection = reduce(projection, event({ type: 'usage', inputTokens: 4, outputTokens: 6, totalTokens: 10 }, 8));
    expect(projection.usage).toEqual({ inputTokens: 14, outputTokens: 26, totalTokens: 40 });
    projection = reduce(projection, event({ type: 'turn_completed', resultLeafId: 'leaf-1' }, 9));
    expect(projection.status).toBe('completed');
    expect(projection.lastSequence).toBe(9);
  });

  it('records the first turn start and preserves tool lifecycle timestamps across updates', () => {
    let projection = createInitialTurnStreamProjection(identity);
    projection = reduce(projection, event({ type: 'turn_started' }, 0));
    projection = reduce(projection, event({ type: 'turn_started' }, 1));
    projection = reduce(projection, event({ type: 'tool_queued', callId: 'call-1', name: 'lookup' }, 2));
    expect(projection.tools[0]).not.toHaveProperty('startedAt');
    projection = reduce(projection, event({ type: 'tool_started', callId: 'call-1', name: 'lookup' }, 3));
    projection = reduce(projection, event({ type: 'tool_completed', callId: 'call-1', name: 'lookup', isError: false }, 4));
    projection = reduce(projection, event({ type: 'tool_started', callId: 'call-1', name: 'lookup' }, 5));
    projection = reduce(projection, event({ type: 'tool_completed', callId: 'call-1', name: 'lookup', isError: false }, 6));

    expect(projection.startedAt).toBe(new Date(0).toISOString());
    expect(projection.tools[0]).toMatchObject({ startedAt: new Date(3_000).toISOString(), completedAt: new Date(4_000).toISOString() });
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

  it('completes an assistant message from the durable message content when no text delta was emitted', () => {
    const projector = new TurnStreamProjector(identity);
    const events = projector.project({
      type: 'message_end',
      message: {
        ...assistantMessage(),
        content: [{ type: 'text', text: 'final answer' }],
      },
    } satisfies AgentSessionEvent);

    expect(events.map((event) => event.type)).toEqual([
      'assistant_message_started',
      'assistant_text_delta',
      'assistant_message_completed',
    ]);
    expect(events[1]).toMatchObject({ type: 'assistant_text_delta', delta: 'final answer' });
  });

  it('does not emit an orphan assistant completion for a tool-call-only message', () => {
    const projector = new TurnStreamProjector(identity);
    const events = projector.project({
      type: 'message_end',
      message: {
        ...assistantMessage(),
        finishReason: 'tool_calls',
        toolCalls: [{ callId: 'call-1', name: 'lookup', arguments: {} }],
      },
    } satisfies AgentSessionEvent);

    expect(events.map((event) => event.type)).toEqual(['tool_queued']);
  });

  it('resolves and reuses one UI-safe display across a tool lifecycle', () => {
    const display = { title: 'Inspect Worksheet', subject: 'Sheet1' };
    const resolver = vi.fn(() => display);
    const projector = new TurnStreamProjector({ ...identity, toolPresentationResolver: resolver });
    const toolCall = { callId: 'call-1', name: 'get_sheet_profile', arguments: { sheetName: 'Sheet1' } };

    const queued = projector.project({
      type: 'message_end',
      message: {
        ...assistantMessage(),
        finishReason: 'tool_calls',
        toolCalls: [toolCall],
      },
    } satisfies AgentSessionEvent);
    const started = projector.project({ type: 'tool_execution_start', toolCall } satisfies AgentSessionEvent);
    const completed = projector.project({
      type: 'tool_execution_end',
      toolCall,
      result: { role: 'tool', callId: 'call-1', name: 'get_sheet_profile', content: [], isError: false },
    } satisfies AgentSessionEvent);

    expect(queued[0]).toMatchObject({ type: 'tool_queued', display });
    expect(started[0]).toMatchObject({ type: 'tool_started', display });
    expect(completed[0]).toMatchObject({ type: 'tool_completed', display });
    expect(resolver).toHaveBeenCalledOnce();
  });

  it('falls back to the tool name when presentation resolution is unavailable or fails', () => {
    const unavailable = new TurnStreamProjector(identity).project({
      type: 'tool_execution_start',
      toolCall: { callId: 'call-1', name: 'unknown_tool', arguments: {} },
    } satisfies AgentSessionEvent);
    const failing = new TurnStreamProjector({
      ...identity,
      toolPresentationResolver: () => { throw new Error('presentation failed'); },
    }).project({
      type: 'tool_execution_start',
      toolCall: { callId: 'call-2', name: 'failing_tool', arguments: {} },
    } satisfies AgentSessionEvent);

    expect(unavailable[0]).toMatchObject({ display: { title: 'unknown_tool' } });
    expect(failing[0]).toMatchObject({ display: { title: 'failing_tool' } });
  });

  it('keeps displays isolated between different tool calls', () => {
    const resolver = vi.fn(({ name }: { name: string }) => ({ title: name }));
    const projector = new TurnStreamProjector({ ...identity, toolPresentationResolver: resolver });

    const first = projector.project({ type: 'tool_execution_start', toolCall: { callId: 'call-1', name: 'first_tool', arguments: {} } } satisfies AgentSessionEvent);
    const second = projector.project({ type: 'tool_execution_start', toolCall: { callId: 'call-2', name: 'second_tool', arguments: {} } } satisfies AgentSessionEvent);
    const firstAgain = projector.project({ type: 'tool_execution_end', toolCall: { callId: 'call-1', name: 'first_tool', arguments: {} }, result: { role: 'tool', callId: 'call-1', name: 'first_tool', content: [], isError: false } } satisfies AgentSessionEvent);

    expect(first[0]).toMatchObject({ display: { title: 'first_tool' } });
    expect(second[0]).toMatchObject({ display: { title: 'second_tool' } });
    expect(firstAgain[0]).toMatchObject({ display: { title: 'first_tool' } });
    expect(resolver).toHaveBeenCalledTimes(2);
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
