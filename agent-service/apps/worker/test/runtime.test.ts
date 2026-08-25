import { describe, expect, it, vi } from 'vitest';

import { createWorkerRuntime, type WorkerRuntimeDependencies } from '../src/runtime.js';
import { createShutdownHandler } from '../src/shutdown.js';

function createDependencies(
  disconnect: WorkerRuntimeDependencies['database']['disconnect'],
): WorkerRuntimeDependencies {
  return {
    database: { disconnect },
    analysisRuns: {} as WorkerRuntimeDependencies['analysisRuns'],
    agentRuntime: {},
    observability: {},
  };
}

describe('Worker runtime lifecycle', () => {
  it('starts without work and closes the database lifecycle once', async () => {
    const disconnect = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const runtime = createWorkerRuntime(createDependencies(disconnect));

    await runtime.start();
    await Promise.all([runtime.close(), runtime.close()]);

    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('handles repeated termination requests only once', async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const exit = vi.fn();
    const shutdown = createShutdownHandler({ start: async () => undefined, close }, exit);

    await Promise.all([shutdown(), shutdown()]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('sets a non-zero exit code when graceful shutdown fails', async () => {
    const exit = vi.fn();
    const shutdown = createShutdownHandler(
      {
        start: async () => undefined,
        close: async () => {
          throw new Error('disconnect failed');
        },
      },
      exit,
    );

    await shutdown();

    expect(exit).toHaveBeenCalledWith(1);
  });
});
