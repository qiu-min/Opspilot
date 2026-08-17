import { describe, expect, it } from 'vitest';

import {
  ANALYSIS_RUN_JOB_NAME,
  ANALYSIS_RUN_JOB_SCHEMA_VERSION,
  ANALYSIS_RUN_QUEUE_NAME,
  analysisRunJobSchema,
  createAnalysisRunJob,
  DEFAULT_ANALYSIS_RUN_JOB_OPTIONS,
  getAnalysisRunJobId,
} from '../src/index.js';

const input = {
  incidentId: '11111111-1111-4111-8111-111111111111',
  runId: '22222222-2222-4222-8222-222222222222',
  outboxMessageId: '33333333-3333-4333-8333-333333333333',
};

describe('analysis run queue contract', () => {
  it('creates a versioned job with a stable outbox-based queue identity', () => {
    const job = createAnalysisRunJob(input);

    expect(job).toEqual({ ...input, schemaVersion: ANALYSIS_RUN_JOB_SCHEMA_VERSION });
    expect(getAnalysisRunJobId(job)).toBe(input.outboxMessageId);
  });

  it.each([
    [{ ...input, incidentId: 'not-a-uuid', schemaVersion: 1 }],
    [{ ...input, schemaVersion: 2 }],
    [{ incidentId: input.incidentId, runId: input.runId, schemaVersion: 1 }],
  ])('rejects an invalid queue payload: %o', (payload) => {
    expect(analysisRunJobSchema.safeParse(payload).success).toBe(false);
  });

  it('keeps queue names and retry policy in one stable contract', () => {
    expect(ANALYSIS_RUN_QUEUE_NAME).toBe('analysis-runs');
    expect(ANALYSIS_RUN_JOB_NAME).toBe('analysis.run.requested');
    expect(DEFAULT_ANALYSIS_RUN_JOB_OPTIONS).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 1_000 },
    });
  });
});
