import { z } from 'zod';

/** The only queue used for first-pass incident analysis. */
export const ANALYSIS_RUN_QUEUE_NAME = 'analysis-runs';
export const ANALYSIS_RUN_JOB_NAME = 'analysis.run.requested';
export const ANALYSIS_RUN_JOB_SCHEMA_VERSION = 1 as const;

/**
 * Queue-library-neutral defaults. Day 5.4 maps these values to BullMQ options.
 * An analysis job is delivered at least once; the outbox message is its queue identity.
 */
export const DEFAULT_ANALYSIS_RUN_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1_000,
  },
} as const;

export const analysisRunJobSchema = z.object({
  incidentId: z.uuid(),
  runId: z.uuid(),
  outboxMessageId: z.uuid(),
  schemaVersion: z.literal(ANALYSIS_RUN_JOB_SCHEMA_VERSION),
});

export type AnalysisRunJob = z.infer<typeof analysisRunJobSchema>;
export type CreateAnalysisRunJobInput = Omit<AnalysisRunJob, 'schemaVersion'>;

/** Creates a versioned, validated message for a first-pass analysis job. */
export function createAnalysisRunJob(input: CreateAnalysisRunJobInput): AnalysisRunJob {
  return analysisRunJobSchema.parse({
    ...input,
    schemaVersion: ANALYSIS_RUN_JOB_SCHEMA_VERSION,
  });
}

/** Keeps duplicate publication of a single outbox record on one queue job identity. */
export function getAnalysisRunJobId(job: AnalysisRunJob): string {
  return job.outboxMessageId;
}
