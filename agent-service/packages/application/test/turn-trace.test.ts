import { describe, expect, it } from 'vitest';
import { Turn } from '@opspilot/domain';

import { TurnNotFoundError } from '../src/turn/errors/turn-not-found-error.js';
import { GetTurnTrace } from '../src/turn/trace/get-turn-trace.js';
import { InMemoryTurnStore } from './support/in-memory-turn-store.js';

describe('GetTurnTrace', () => {
  it('returns Turn identity and snapshot status when the event history is empty', () => {
    const turn = Turn.create({
      id: 'turn-empty-trace',
      sessionId: 'session-empty-trace',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    turn.start('2026-01-01T00:00:01.000Z');

    const turnStore = new InMemoryTurnStore();
    turnStore.create(turn);
    turnStore.save(turn);

    const trace = new GetTurnTrace({ turnStore }).execute(turn.getId());

    expect(trace).toEqual({
      turnId: 'turn-empty-trace',
      sessionId: 'session-empty-trace',
      status: 'running',
      startedAt: '2026-01-01T00:00:01.000Z',
      endedAt: null,
      durationMs: null,
      spans: [],
    });
  });

  it('uses TurnNotFoundError for missing Turn state and events', () => {
    const turnStore = new InMemoryTurnStore();

    expect(() => turnStore.load('missing-turn')).toThrow(TurnNotFoundError);
    expect(() => turnStore.loadEvents('missing-turn')).toThrow(TurnNotFoundError);
  });
});
