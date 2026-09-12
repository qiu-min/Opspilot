import { describe, expect, it } from 'vitest';

import {
  Turn,
  TurnEventError,
  TurnStateError,
  type TurnCheckpoint,
  type TurnState,
  validateTurnEvent,
  validateTurnCheckpoint,
} from '../src/index.js';

const createdAt = '2026-01-01T00:00:00.000Z';
const startedAt = '2026-01-01T00:00:01.000Z';
const later = '2026-01-01T00:00:02.000Z';
const completedAt = '2026-01-01T00:00:03.000Z';

function createTurn(): Turn {
  return Turn.create({
    id: 'turn-1',
    sessionId: 'session-1',
    baseLeafId: 'leaf-0',
    createdAt,
  });
}

function startTurn(): Turn {
  const turn = createTurn();
  turn.start(startedAt);
  return turn;
}

function checkpoint(eventSequence: number): TurnCheckpoint {
  return {
    eventSequence,
    sessionLeafId: 'leaf-1',
    phase: 'assistant_committed',
  };
}

describe('Turn', () => {
  it('creates a pending Turn with stable identity and no attempt', () => {
    const turn = createTurn();

    expect(turn.getState()).toEqual({
      id: 'turn-1',
      sessionId: 'session-1',
      status: 'pending',
      baseLeafId: 'leaf-0',
      inputEntryId: null,
      resultLeafId: null,
      attempt: 0,
      checkpoint: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    });
  });

  it('starts once and records the first attempt', () => {
    const turn = createTurn();

    turn.start(startedAt);

    expect(turn.getState()).toMatchObject({ status: 'running', attempt: 1, startedAt });
  });

  it('records input idempotently and rejects a different input id', () => {
    const turn = createTurn();

    turn.recordInput('entry-1');
    turn.recordInput('entry-1');

    expect(() => turn.recordInput('entry-2')).toThrow(TurnStateError);
    expect(turn.getState().inputEntryId).toBe('entry-1');
  });

  it('records the latest durable result leaf before completion', () => {
    const turn = startTurn();

    turn.recordResultLeaf('leaf-1');

    expect(turn.getState().resultLeafId).toBe('leaf-1');
    turn.complete(undefined, completedAt);
    expect(turn.getState().resultLeafId).toBe('leaf-1');
  });

  it('marks a running Turn interrupted and resumes it with a new attempt', () => {
    const turn = startTurn();

    turn.markInterrupted(later);
    expect(turn.getState()).toMatchObject({ status: 'interrupted', attempt: 1 });

    turn.resume(completedAt);
    expect(turn.getState()).toMatchObject({
      status: 'running',
      attempt: 2,
      startedAt,
      completedAt: null,
    });
  });

  it.each([
    ['completed', (turn: Turn) => turn.complete('leaf-2', completedAt)],
    ['failed', (turn: Turn) => turn.fail(completedAt)],
    ['cancelled', (turn: Turn) => turn.cancel(completedAt)],
  ] as const)('supports running -> %s as a terminal transition', (_status, complete) => {
    const turn = startTurn();

    complete(turn);

    expect(turn.getState().status).toBe(_status);
    expect(turn.getState().completedAt).toBe(completedAt);
  });

  it('rejects invalid transitions', () => {
    const pending = createTurn();
    expect(() => pending.complete()).toThrow(TurnStateError);

    const completed = startTurn();
    completed.complete('leaf-2', completedAt);
    expect(() => completed.resume()).toThrow(TurnStateError);
    expect(() => completed.fail()).toThrow(TurnStateError);
    expect(() => completed.cancel()).toThrow(TurnStateError);

    const failed = startTurn();
    failed.fail(completedAt);
    expect(() => failed.start()).toThrow(TurnStateError);

    const cancelled = startTurn();
    cancelled.cancel(completedAt);
    expect(() => cancelled.resume()).toThrow(TurnStateError);
  });

  it('advances checkpoints monotonically and returns cloned snapshots', () => {
    const turn = startTurn();
    const first = checkpoint(0);

    turn.advanceCheckpoint(first);
    expect(turn.getState().checkpoint).toEqual(first);
    expect(() => turn.advanceCheckpoint(first)).toThrow(TurnStateError);
    expect(() => turn.advanceCheckpoint(checkpoint(0))).toThrow(TurnStateError);
    expect(() => turn.advanceCheckpoint(checkpoint(-1))).toThrow();

    const snapshot = turn.getState();
    expect(snapshot).not.toBe(turn.getState());
  });

  it('accepts only durable checkpoint phases', () => {
    for (const phase of ['input_committed', 'assistant_committed', 'tool_completed'] as const) {
      expect(() =>
        validateTurnCheckpoint({ eventSequence: 0, sessionLeafId: 'leaf-1', phase }),
      ).not.toThrow();
    }

    expect(() =>
      validateTurnCheckpoint({
        eventSequence: 0,
        sessionLeafId: 'leaf-1',
        phase: 'model_completed',
      } as unknown as TurnCheckpoint),
    ).toThrow();
  });

  it.each(['resultEntryId', 'sessionLeafId'] as const)(
    'requires %s on tool_completed events',
    (field) => {
      const event: Record<string, unknown> = {
        version: 2,
        id: 'event-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        sequence: 0,
        attempt: 1,
        timestamp: startedAt,
        type: 'tool_completed',
        callId: 'call-1',
        name: 'lookup',
        isError: false,
        resultEntryId: 'entry-1',
        sessionLeafId: 'entry-1',
      };
      delete event[field];

      expect(() => validateTurnEvent(event)).toThrow(TurnEventError);
    },
  );

  it('accepts tool_completed only with durable result identity', () => {
    expect(() =>
      validateTurnEvent({
        version: 2,
        id: 'event-1',
        turnId: 'turn-1',
        sessionId: 'session-1',
        sequence: 0,
        attempt: 1,
        timestamp: startedAt,
        type: 'tool_completed',
        callId: 'call-1',
        name: 'lookup',
        isError: false,
        resultEntryId: 'entry-1',
        sessionLeafId: 'entry-1',
      }),
    ).not.toThrow();
  });

  it('rejects checkpoint changes after a terminal transition', () => {
    const turn = startTurn();
    turn.complete('leaf-2', completedAt);

    expect(() => turn.advanceCheckpoint(checkpoint(0))).toThrow(TurnStateError);
  });

  it('restores valid state and rejects corrupt combinations', () => {
    const state: TurnState = {
      ...startTurn().getState(),
      checkpoint: checkpoint(2),
    };
    const restored = Turn.restore(state);
    expect(restored.getState()).toEqual(state);

    expect(() =>
      Turn.restore({ ...state, status: 'pending', attempt: 1 } as TurnState),
    ).toThrow(TurnStateError);
    expect(() =>
      Turn.restore({ ...state, completedAt, status: 'running' } as TurnState),
    ).toThrow(TurnStateError);
    expect(() =>
      Turn.restore({ ...state, startedAt: null, status: 'completed' } as TurnState),
    ).toThrow(TurnStateError);
  });
});
