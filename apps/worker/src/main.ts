import { createDatabaseRepositoryContainer } from '@opspilot/db';

import { createWorkerRuntime } from './runtime.js';
import { createShutdownHandler } from './shutdown.js';

async function bootstrap(): Promise<void> {
  const repositories = createDatabaseRepositoryContainer();
  const runtime = createWorkerRuntime({
    database: repositories,
    analysisRuns: repositories.analysisRuns,
    agentRuntime: {},
    observability: {},
  });
  await runtime.start();

  const keepAlive = setInterval(() => undefined, 2_147_483_647);
  const shutdown = createShutdownHandler(runtime, (code) => {
    clearInterval(keepAlive);
    process.exitCode = code;
  });
  const onSignal = () => void shutdown();

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
}

void bootstrap().catch((error: unknown) => {
  console.error('Worker failed to start.', error);
  process.exitCode = 1;
});
