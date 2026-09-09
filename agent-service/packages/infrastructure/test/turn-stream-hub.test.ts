import { describe, expect, it } from 'vitest';

import { InMemoryTurnStreamHub } from '../src/index.js';
import { TurnStreamReplayGapError } from '@opspilot/application';

const identity = { turnId: 'turn-1', sessionId: 'session-1' };

describe('InMemoryTurnStreamHub', () => {
  it('keeps an active projection with no subscribers and clears active status at terminal', async () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    hub.publish({ type: 'turn_started', ...identity });
    hub.publish({ type: 'assistant_text_delta', delta: 'hello', ...identity });

    expect(hub.getActiveTurn(identity.sessionId)).toMatchObject({
      turnId: identity.turnId,
      projection: { assistant: { text: 'hello' }, lastSequence: 1 },
    });

    const terminal = hub.publish({ type: 'turn_completed', resultLeafId: 'leaf-1', ...identity });
    expect(terminal.sequence).toBe(2);
    expect(hub.getActiveTurn(identity.sessionId)).toBeNull();
  });

  it('assigns independent contiguous sequences per Turn', () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    hub.openTurn({ turnId: 'turn-2', sessionId: 'session-2' });

    expect(hub.publish({ type: 'turn_started', ...identity }).sequence).toBe(0);
    expect(hub.publish({ type: 'assistant_text_delta', delta: 'a', ...identity }).sequence).toBe(1);
    expect(
      hub.publish({ type: 'turn_started', turnId: 'turn-2', sessionId: 'session-2' }).sequence,
    ).toBe(0);
  });

  it('replays afterSequence and then continues with live events in order', async () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    for (const delta of ['a', 'b', 'c', 'd', 'e']) {
      hub.publish({ type: 'assistant_text_delta', delta, ...identity });
    }

    const stream = hub.subscribe(identity.turnId, 2);
    const iterator = stream[Symbol.asyncIterator]();
    hub.publish({ type: 'assistant_text_delta', delta: 'f', ...identity });
    hub.publish({ type: 'assistant_text_delta', delta: 'g', ...identity });

    const received = await Promise.all(
      Array.from({ length: 4 }, async () => (await iterator.next()).value),
    );
    expect(received.map((event) => event?.sequence)).toEqual([3, 4, 5, 6]);
    await iterator.return?.();
  });

  it('does not leave a gap between a projection snapshot and reattach', async () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    for (let sequence = 0; sequence <= 10; sequence += 1) {
      hub.publish({ type: 'assistant_text_delta', delta: String(sequence), ...identity });
    }
    expect(hub.getProjection(identity.turnId)?.lastSequence).toBe(10);

    hub.publish({ type: 'assistant_text_delta', delta: '11', ...identity });
    hub.publish({ type: 'assistant_text_delta', delta: '12', ...identity });
    const iterator = hub.subscribe(identity.turnId, 10)[Symbol.asyncIterator]();
    hub.publish({ type: 'assistant_text_delta', delta: '13', ...identity });

    const received = await Promise.all(
      Array.from({ length: 3 }, async () => (await iterator.next()).value),
    );
    expect(received.map((event) => event?.sequence)).toEqual([11, 12, 13]);
    await iterator.return?.();
  });

  it('supports multiple subscribers and isolates unsubscribe', async () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    const first = hub.subscribe(identity.turnId)[Symbol.asyncIterator]();
    const second = hub.subscribe(identity.turnId)[Symbol.asyncIterator]();

    hub.publish({ type: 'assistant_text_delta', delta: 'one', ...identity });
    expect((await first.next()).value?.sequence).toBe(0);
    expect((await second.next()).value?.sequence).toBe(0);
    await first.return?.();

    hub.publish({ type: 'assistant_text_delta', delta: 'two', ...identity });
    expect((await second.next()).value?.sequence).toBe(1);
    await second.return?.();
    expect(hub.getActiveTurn(identity.sessionId)).not.toBeNull();
  });

  it('reports a replay gap instead of silently skipping events', () => {
    const hub = new InMemoryTurnStreamHub({ replayCapacity: 3 });
    hub.openTurn(identity);
    for (const delta of ['a', 'b', 'c', 'd', 'e']) {
      hub.publish({ type: 'assistant_text_delta', delta, ...identity });
    }

    expect(() => hub.subscribe(identity.turnId, 0)).toThrow(TurnStreamReplayGapError);
    expect(() => hub.subscribe(identity.turnId, 2)).not.toThrow();
  });

  it('closes subscribers only after delivering a terminal event', async () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    const iterator = hub.subscribe(identity.turnId)[Symbol.asyncIterator]();
    hub.publish({ type: 'turn_failed', message: 'failed safely', ...identity });

    expect((await iterator.next()).value?.type).toBe('turn_failed');
    expect((await iterator.next()).done).toBe(true);
    await iterator.return?.();
  });
});
