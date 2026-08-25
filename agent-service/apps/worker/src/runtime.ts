import type { AgentRuntimeBoundary } from '@opspilot/agent-runtime';
import type { AnalysisRunJob, AnalysisRunRepository } from '@opspilot/application';
import type { ObservabilityBoundary } from '@opspilot/observability';

export interface WorkerDatabaseLifecycle {
  disconnect(): Promise<void>;
}

export interface WorkerRuntimeDependencies {
  readonly database: WorkerDatabaseLifecycle;
  readonly analysisRuns: AnalysisRunRepository;
  readonly agentRuntime: AgentRuntimeBoundary;
  readonly observability: ObservabilityBoundary;
}

export interface WorkerRuntime {
  start(): Promise<void>;
  close(): Promise<void>;
}

/** The validated payload that a future queue consumer passes to a Worker handler. */
export type WorkerAnalysisJob = AnalysisRunJob;

/**
 * Day 5.1 lifecycle boundary. Queue consumers are added after BullMQ is introduced.
 */
export function createWorkerRuntime(dependencies: WorkerRuntimeDependencies): WorkerRuntime {
  let closePromise: Promise<void> | undefined;

  return {
    async start(): Promise<void> {
      // Keeping the composition dependencies explicit prevents future handlers from
      // reaching for Prisma directly. Day 5.1 intentionally has no work to start.
      void dependencies.analysisRuns;
      void dependencies.agentRuntime;
      void dependencies.observability;
    },
    close(): Promise<void> {
      closePromise ??= dependencies.database.disconnect();
      return closePromise;
    },
  };
}
