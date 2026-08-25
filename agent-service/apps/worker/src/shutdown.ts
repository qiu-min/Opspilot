import type { WorkerRuntime } from './runtime.js';

export type ProcessExit = (code: number) => void;

/** Creates an idempotent graceful-shutdown handler that is easy to unit test. */
export function createShutdownHandler(
  runtime: WorkerRuntime,
  exit: ProcessExit,
): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= runtime.close().then(
      () => exit(0),
      () => exit(1),
    );
    return shutdownPromise;
  };
}
