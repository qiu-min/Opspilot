import { describe, expect, it, vi } from 'vitest';
import { Turn } from '@opspilot/domain';

import { RecoverTurnsOnStartup, type ResumeTurnResult } from '../src/index.js';
import { InMemoryTurnStore } from './support/in-memory-turn-store.js';

describe('RecoverTurnsOnStartup', () => {
  it('processes recoverable Turns serially and continues after blocked or failed results', async () => {
    const turnStore = new InMemoryTurnStore();
    const first = createRecoverableTurn('turn-a', 'session-a');
    const second = createRecoverableTurn('turn-b', 'session-b');
    const third = createRecoverableTurn('turn-c', 'session-c');
    turnStore.create(first);
    turnStore.create(second);
    turnStore.create(third);

    const calls: string[] = [];
    const resumeTurn = {
      execute: vi.fn(async (turnId: string): Promise<ResumeTurnResult> => {
        calls.push(turnId);
        if (turnId === 'turn-b') return result(turnId, 'blocked', 'session-b');
        if (turnId === 'turn-c') throw new Error('simulated recovery failure');
        return result(turnId, 'resumed', 'session-a');
      }),
    };
    const logger = { info: vi.fn(), error: vi.fn() };

    const summary = await new RecoverTurnsOnStartup({ turnStore, resumeTurn, logger }).execute();

    expect(calls).toEqual(['turn-a', 'turn-b', 'turn-c']);
    expect(summary).toEqual({ inspected: 3, resumed: 1, reconciled: 0, blocked: 1, failed: 1 });
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

function createRecoverableTurn(id: string, sessionId: string): Turn {
  const turn = Turn.create({ id, sessionId, createdAt: '2026-01-01T00:00:00.000Z' });
  turn.start('2026-01-01T00:00:01.000Z');
  return turn;
}

function result(
  turnId: string,
  kind: ResumeTurnResult['kind'],
  sessionId: string,
): ResumeTurnResult {
  return { turnId, sessionId, kind, attempt: 1 };
}
