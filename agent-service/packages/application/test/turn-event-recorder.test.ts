import { describe, expect, it } from 'vitest';

import { Session, Turn } from '@opspilot/domain';
import type { AssistantMessage, ToolResultMessage } from '@opspilot/model-gateway';

import { toSessionMessage } from '../src/session/runtime/session-message-mapper.js';
import { TurnEventRecorder } from '../src/turn/execution/turn-event-recorder.js';
import { InMemoryTurnStore } from './support/in-memory-turn-store.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function startedRecorder(): {
  recorder: TurnEventRecorder;
  turnStore: InMemoryTurnStore;
  turn: Turn;
  session: Session;
} {
  const turn = Turn.create({ id: 'turn-recorder-1', sessionId: 'session-1', createdAt: timestamp });
  turn.start(timestamp);
  const turnStore = new InMemoryTurnStore();
  turnStore.create(turn);
  const session = Session.create({ id: 'session-1', timestamp });
  const recorder = new TurnEventRecorder(turn, turnStore, session);
  recorder.recordTurnStarted();
  return { recorder, turnStore, turn, session };
}

function failedMessage(
  finishReason: 'error' | 'aborted',
  modelError?: AssistantMessage['modelError'],
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'moonshot',
    model: 'kimi',
    content: [],
    finishReason,
    errorMessage: 'legacy failure',
    ...(modelError === undefined ? {} : { modelError }),
  };
}

describe('TurnEventRecorder model failures', () => {
  it('records a retry snapshot without recording an intermediate terminal model fact', () => {
    const { recorder, turnStore } = startedRecorder();
    const error = {
      kind: 'rate_limit' as const,
      code: 'MODEL_RATE_LIMIT' as const,
      message: 'Model provider rate limit exceeded.',
      retryable: true,
      statusCode: 429,
    };

    recorder.recordAgentSessionEvent({ type: 'step_start', modelCallId: 'model-call-A' });
    recorder.recordAgentSessionEvent({
      type: 'model_retry',
      modelCallId: 'model-call-A',
      failedAttempt: 1,
      nextAttempt: 2,
      delayMs: 500,
      error,
    });

    const events = turnStore.loadEvents('turn-recorder-1');
    expect(events).toMatchObject([
      { type: 'turn_started' },
      { type: 'model_started', modelCallId: 'model-call-A' },
      {
        type: 'model_retry_scheduled',
        modelCallId: 'model-call-A',
        failedAttempt: 1,
        nextAttempt: 2,
        delayMs: 500,
        error,
      },
    ]);
    expect(events.some((event) => event.type === 'model_failed')).toBe(false);
    expect(events.some((event) => event.type === 'assistant_message_completed')).toBe(false);
  });

  it('records model_failed and keeps usage without recording model_completed', () => {
    const { recorder, turnStore } = startedRecorder();
    const message = failedMessage('error', {
      kind: 'rate_limit',
      code: 'MODEL_RATE_LIMIT',
      message: 'Model provider rate limit exceeded.',
      retryable: true,
      statusCode: 429,
    });
    const withUsage = { ...message, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } };

    recorder.recordAgentSessionEvent({ type: 'step_start', modelCallId: 'model-call-A' });
    recorder.recordAgentSessionEvent({
      type: 'message_end',
      message: withUsage,
      modelCallId: 'model-call-A',
    });

    const events = turnStore.loadEvents('turn-recorder-1');
    expect(events).toMatchObject([
      { type: 'turn_started' },
      { type: 'model_started', modelCallId: 'model-call-A' },
      { type: 'model_failed', modelCallId: 'model-call-A', error: message.modelError },
      { type: 'usage_recorded', modelCallId: 'model-call-A', totalTokens: 5 },
    ]);
    const modelFailed = events.find((event) => event.type === 'model_failed');
    const usageRecorded = events.find((event) => event.type === 'usage_recorded');
    expect(modelFailed?.sequence).toBeLessThan(usageRecorded?.sequence ?? Number.MAX_SAFE_INTEGER);
    expect(events.some((event) => event.type === 'model_completed')).toBe(false);
  });

  it('does not record aborted or synthetic runtime failures as model_failed', () => {
    const { recorder, turnStore } = startedRecorder();

    recorder.recordAgentSessionEvent({ type: 'message_end', message: failedMessage('aborted') });
    recorder.recordAgentSessionEvent({
      type: 'message_end',
      message: failedMessage('error'),
    });

    expect(turnStore.loadEvents('turn-recorder-1')).toMatchObject([{ type: 'turn_started' }]);
  });

  it('maps a legacy model failure to an unknown durable snapshot', () => {
    const { recorder, turnStore } = startedRecorder();

    recorder.recordAgentSessionEvent({ type: 'step_start', modelCallId: 'model-call-legacy' });
    recorder.recordAgentSessionEvent({
      type: 'message_end',
      message: failedMessage('error'),
      modelCallId: 'model-call-legacy',
    });

    expect(turnStore.loadEvents('turn-recorder-1')).toContainEqual(
      expect.objectContaining({
        type: 'model_failed',
        modelCallId: 'model-call-legacy',
        error: {
          kind: 'unknown',
          code: 'MODEL_UNKNOWN',
          message: 'legacy failure',
          retryable: false,
        },
      }),
    );
  });
});

describe('TurnEventRecorder tool results', () => {
  it('stores Runtime ToolResult details in tool_completed after the Session entry', () => {
    const { recorder, turnStore, session } = startedRecorder();
    session.appendMessage({
      role: 'assistant',
      api: 'openai-completions',
      provider: 'moonshot',
      model: 'kimi',
      content: [],
      finishReason: 'tool_calls',
      toolCalls: [{ callId: 'call-1', name: 'aggregate_data', arguments: {} }],
    });
    const runtimeMessage: ToolResultMessage = {
      role: 'tool',
      callId: 'call-1',
      name: 'aggregate_data',
      content: [{ type: 'text', text: 'Aggregated 4 rows.' }],
      details: { sheetName: 'SalesData', resultRowCount: 4 },
      isError: false,
    };
    const sessionMessage = toSessionMessage(runtimeMessage);
    if (sessionMessage === undefined) throw new Error('Expected a Session ToolResult message.');
    const resultEntry = session.appendMessage(sessionMessage);

    recorder.recordToolCompleted(runtimeMessage);

    const event = turnStore
      .loadEvents('turn-recorder-1')
      .find((item) => item.type === 'tool_completed');
    expect(event).toMatchObject({
      type: 'tool_completed',
      callId: runtimeMessage.callId,
      resultEntryId: resultEntry.id,
      sessionLeafId: resultEntry.id,
      resultDetails: runtimeMessage.details,
    });
    expect(resultEntry.message).not.toHaveProperty('details');
  });

  it('rejects non-JSON ToolResult details before appending tool_completed', () => {
    const { recorder, turnStore, session } = startedRecorder();
    session.appendMessage({
      role: 'assistant',
      api: 'openai-completions',
      provider: 'moonshot',
      model: 'kimi',
      content: [],
      finishReason: 'tool_calls',
      toolCalls: [{ callId: 'call-1', name: 'lookup', arguments: {} }],
    });
    const runtimeMessage: ToolResultMessage = {
      role: 'tool',
      callId: 'call-1',
      name: 'lookup',
      content: [{ type: 'text', text: 'failed' }],
      details: { nested: undefined },
      isError: true,
    };
    const sessionMessage = toSessionMessage(runtimeMessage);
    if (sessionMessage === undefined) throw new Error('Expected a Session ToolResult message.');
    session.appendMessage(sessionMessage);

    expect(() => recorder.recordToolCompleted(runtimeMessage)).toThrow(
      /ToolResult details(?:\.nested)? must be JSON serializable\./,
    );
    expect(turnStore.loadEvents('turn-recorder-1')).toHaveLength(1);
  });
});
