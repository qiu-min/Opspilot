import { describe, expect, it } from 'vitest';

import { Session, Turn } from '@opspilot/domain';
import type { AssistantMessage } from '@opspilot/model-gateway';

import { TurnEventRecorder } from '../src/turn/execution/turn-event-recorder.js';
import { InMemoryTurnStore } from './support/in-memory-turn-store.js';

const timestamp = '2026-01-01T00:00:00.000Z';

function startedRecorder(): {
  recorder: TurnEventRecorder;
  turnStore: InMemoryTurnStore;
  turn: Turn;
} {
  const turn = Turn.create({ id: 'turn-recorder-1', sessionId: 'session-1', createdAt: timestamp });
  turn.start(timestamp);
  const turnStore = new InMemoryTurnStore();
  turnStore.create(turn);
  const recorder = new TurnEventRecorder(
    turn,
    turnStore,
    Session.create({ id: 'session-1', timestamp }),
  );
  recorder.recordTurnStarted();
  return { recorder, turnStore, turn };
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

    expect(turnStore.loadEvents('turn-recorder-1')).toMatchObject([
      { type: 'turn_started' },
      { type: 'model_started', modelCallId: 'model-call-A' },
      { type: 'usage_recorded', modelCallId: 'model-call-A', totalTokens: 5 },
      { type: 'model_failed', modelCallId: 'model-call-A', error: message.modelError },
    ]);
    expect(
      turnStore.loadEvents('turn-recorder-1').some((event) => event.type === 'model_completed'),
    ).toBe(false);
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
