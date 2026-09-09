import { describe, expect, it } from 'vitest';

import { TurnEventError, isTurnEvent, validateTurnEvent } from '../src/index.js';

const baseEvent = {
  version: 1 as const,
  id: 'event-1',
  turnId: 'turn-1',
  sessionId: 'session-1',
  sequence: 0,
  attempt: 1,
  timestamp: '2026-01-01T00:00:00.000Z',
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

  it.each([
    ['unknown type', { ...baseEvent, type: 'unknown' }],
    ['invalid attempt', { ...baseEvent, type: 'model_started', attempt: 0 }],
    ['invalid sequence', { ...baseEvent, type: 'model_started', sequence: -1 }],
    ['invalid timestamp', { ...baseEvent, type: 'model_started', timestamp: 'invalid' }],
  ])('rejects %s', (_label, event) => {
    expect(() => validateTurnEvent(event)).toThrow(TurnEventError);
  });
});
