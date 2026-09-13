import { describe, expect, it } from 'vitest';

import { TurnEventError, isTurnEvent, validateTurnEvent } from '../src/index.js';

const baseEvent = {
  version: 2 as const,
  id: 'event-1',
  turnId: 'turn-1',
  sessionId: 'session-1',
  sequence: 0,
  attempt: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
  modelCallId: 'model-call-1',
};

describe('TurnEvent validation', () => {
  it('accepts input_committed only with durable entry and leaf ids', () => {
    expect(() =>
      validateTurnEvent({
        ...baseEvent,
        type: 'input_committed',
        entryId: 'entry-1',
        sessionLeafId: 'leaf-1',
      }),
    ).not.toThrow();

    expect(() =>
      validateTurnEvent({
        ...baseEvent,
        type: 'input_committed',
        entryId: '',
        sessionLeafId: 'leaf-1',
      }),
    ).toThrow(TurnEventError);
    expect(() =>
      validateTurnEvent({
        ...baseEvent,
        type: 'input_committed',
        entryId: 'entry-1',
        sessionLeafId: null,
      }),
    ).toThrow(TurnEventError);
  });

  it('requires assistant_message_completed to reference a durable Session leaf', () => {
    expect(
      isTurnEvent({
        ...baseEvent,
        type: 'assistant_message_completed',
        entryId: 'entry-1',
        sessionLeafId: 'leaf-1',
      }),
    ).toBe(true);

    expect(() =>
      validateTurnEvent({
        ...baseEvent,
        type: 'assistant_message_completed',
        entryId: 'entry-1',
        sessionLeafId: null,
      }),
    ).toThrow(TurnEventError);
    expect(() =>
      validateTurnEvent({
        ...baseEvent,
        type: 'assistant_message_completed',
        entryId: 'entry-1',
        sessionLeafId: '',
      }),
    ).toThrow(TurnEventError);
  });

  it('keeps model_completed as a valid execution fact', () => {
    expect(() => validateTurnEvent({ ...baseEvent, type: 'model_completed' })).not.toThrow();
  });

  it('validates model_failed durable error snapshots', () => {
    expect(() =>
      validateTurnEvent({
        ...baseEvent,
        type: 'model_failed',
        error: {
          kind: 'rate_limit',
          code: 'MODEL_RATE_LIMIT',
          message: 'Model provider rate limit exceeded.',
          retryable: true,
          statusCode: 429,
          providerCode: 'rate_limit_exceeded',
        },
      }),
    ).not.toThrow();

    const invalidSnapshots: readonly Record<string, unknown>[] = [
      { kind: 'not-a-kind', code: 'MODEL_UNKNOWN', message: 'failed', retryable: false },
      {
        kind: 'authentication',
        code: 'MODEL_RATE_LIMIT',
        message: 'failed',
        retryable: true,
      },
      { kind: 'rate_limit', code: 'MODEL_RATE_LIMIT', message: 'failed', retryable: false },
      { kind: 'unknown', code: '', message: 'failed', retryable: false },
      { kind: 'unknown', code: 'MODEL_UNKNOWN', message: '', retryable: false },
      { kind: 'unknown', code: 'MODEL_UNKNOWN', message: 'failed', retryable: 'false' },
      {
        kind: 'unknown',
        code: 'MODEL_UNKNOWN',
        message: 'failed',
        retryable: false,
        statusCode: 99,
      },
      {
        kind: 'unknown',
        code: 'MODEL_UNKNOWN',
        message: 'failed',
        retryable: false,
        providerCode: 'bad code',
      },
    ];

    for (const error of invalidSnapshots) {
      expect(() => validateTurnEvent({ ...baseEvent, type: 'model_failed', error })).toThrow(
        TurnEventError,
      );
    }
  });

  it.each(['model_started', 'model_completed', 'usage_recorded'] as const)(
    'requires a non-empty modelCallId for %s',
    (type) => {
      const event =
        type === 'usage_recorded'
          ? {
              ...baseEvent,
              type,
              inputTokens: 1,
              outputTokens: 2,
              totalTokens: 3,
            }
          : { ...baseEvent, type };

      expect(() => validateTurnEvent({ ...event, modelCallId: undefined })).toThrow(TurnEventError);
      expect(() => validateTurnEvent({ ...event, modelCallId: '' })).toThrow(TurnEventError);
      expect(() => validateTurnEvent(event)).not.toThrow();
    },
  );

  it.each([
    ['unknown type', { ...baseEvent, type: 'unknown' }],
    ['invalid attempt', { ...baseEvent, type: 'model_started', attempt: 0 }],
    ['invalid sequence', { ...baseEvent, type: 'model_started', sequence: -1 }],
    ['invalid timestamp', { ...baseEvent, type: 'model_started', timestamp: 'invalid' }],
  ])('rejects %s', (_label, event) => {
    expect(() => validateTurnEvent(event)).toThrow(TurnEventError);
  });

  it('requires all model_failed fields and keeps legacy event records valid', () => {
    const valid = {
      ...baseEvent,
      type: 'model_failed' as const,
      error: {
        kind: 'unknown' as const,
        code: 'MODEL_UNKNOWN',
        message: 'legacy failure',
        retryable: false,
      },
    };
    expect(() => validateTurnEvent(valid)).not.toThrow();
    expect(() => validateTurnEvent({ ...valid, modelCallId: undefined })).toThrow(TurnEventError);
    expect(() => validateTurnEvent({ ...valid, error: undefined })).toThrow(TurnEventError);
    expect(() =>
      validateTurnEvent({
        ...valid,
        error: { ...valid.error, kind: 'invalid' },
      }),
    ).toThrow(TurnEventError);
    expect(() => validateTurnEvent({ ...valid, error: { ...valid.error, code: '' } })).toThrow(
      TurnEventError,
    );
    expect(() => validateTurnEvent({ ...valid, error: { ...valid.error, message: '' } })).toThrow(
      TurnEventError,
    );
    expect(() =>
      validateTurnEvent({
        ...valid,
        error: { ...valid.error, retryable: 'no' },
      }),
    ).toThrow(TurnEventError);
    expect(() =>
      validateTurnEvent({
        ...valid,
        error: { ...valid.error, statusCode: 600 },
      }),
    ).toThrow(TurnEventError);
    expect(() =>
      validateTurnEvent({
        ...valid,
        error: { ...valid.error, providerCode: {} },
      }),
    ).toThrow(TurnEventError);
    expect(() => validateTurnEvent({ ...baseEvent, type: 'model_started' })).not.toThrow();
  });
});
