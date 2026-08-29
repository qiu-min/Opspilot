import { describe, expect, it } from 'vitest';

import { InMemorySessionRunCoordinator } from '../src/index.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('InMemorySessionRunCoordinator', () => {
  it('serializes operations for the same sessionId', async () => {
    const coordinator = new InMemorySessionRunCoordinator();
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const order: string[] = [];

    const first = coordinator.runExclusive('session-1', async () => {
      order.push('first:start');
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      order.push('first:end');
    });
    await firstStarted.promise;

    const second = coordinator.runExclusive('session-1', async () => {
      order.push('second:start');
    });
    await Promise.resolve();

    expect(order).toEqual(['first:start']);
    releaseFirst.resolve(undefined);
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('allows operations for different sessionIds to run concurrently', async () => {
    const coordinator = new InMemorySessionRunCoordinator();
    const firstStarted = createDeferred<void>();
    const secondStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const releaseSecond = createDeferred<void>();
    const order: string[] = [];

    const first = coordinator.runExclusive('session-1', async () => {
      order.push('first:start');
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
    });
    const second = coordinator.runExclusive('session-2', async () => {
      order.push('second:start');
      secondStarted.resolve(undefined);
      await releaseSecond.promise;
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(order).toEqual(['first:start', 'second:start']);
    releaseFirst.resolve(undefined);
    releaseSecond.resolve(undefined);
    await Promise.all([first, second]);
  });

  it('releases a session queue after failure so the next operation can run', async () => {
    const coordinator = new InMemorySessionRunCoordinator();
    const firstStarted = createDeferred<void>();
    const releaseFirst = createDeferred<void>();

    const failing = coordinator.runExclusive('session-1', async () => {
      firstStarted.resolve(undefined);
      await releaseFirst.promise;
      throw new Error('first failed');
    });
    await firstStarted.promise;

    const succeeding = coordinator.runExclusive('session-1', async () => 'second completed');
    releaseFirst.resolve(undefined);

    await expect(failing).rejects.toThrow('first failed');
    await expect(succeeding).resolves.toBe('second completed');
  });

  it('removes idle session queue state', async () => {
    const coordinator = new InMemorySessionRunCoordinator();
    const internal = coordinator as unknown as { queues: Map<string, unknown> };

    await coordinator.runExclusive('session-1', async () => undefined);

    expect(internal.queues.size).toBe(0);
  });
});
