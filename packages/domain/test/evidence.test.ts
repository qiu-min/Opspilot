import { describe, expect, it } from 'vitest';

import { evidenceSchema } from '../src/index.js';

describe('Evidence schema', () => {
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  it('accepts structured evidence with its source run', () => {
    const result = evidenceSchema.parse({
      id,
      incidentId: id,
      sourceRunId: id,
      kind: 'METRICS',
      summary: 'Database connection usage reached 100%.',
      content: { connectionUsage: 100 },
      contentHash: 'sha256:example',
      sourceUri: 'metrics://database/connections',
      timeRangeStart: '2026-08-11T12:00:00.000Z',
      timeRangeEnd: '2026-08-11T12:15:00.000Z',
      createdAt: '2026-08-11T12:16:00.000Z',
    });

    expect(result.kind).toBe('METRICS');
    expect(result.content).toEqual({ connectionUsage: 100 });
  });

  it('accepts incident-level evidence without a source run, URI, or time range', () => {
    expect(
      evidenceSchema.safeParse({
        id,
        incidentId: id,
        sourceRunId: null,
        kind: 'RUNBOOK',
        summary: 'Connection pool exhaustion runbook.',
        content: '# Runbook',
        contentHash: 'sha256:example',
        sourceUri: null,
        timeRangeStart: null,
        timeRangeEnd: null,
        createdAt: '2026-08-11T12:16:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects an invalid evidence kind or empty summary', () => {
    expect(
      evidenceSchema.safeParse({
        id,
        incidentId: id,
        sourceRunId: null,
        kind: 'UNKNOWN',
        summary: '',
        content: {},
        contentHash: 'sha256:example',
        sourceUri: null,
        timeRangeStart: null,
        timeRangeEnd: null,
        createdAt: '2026-08-11T12:16:00.000Z',
      }).success,
    ).toBe(false);
  });
});
