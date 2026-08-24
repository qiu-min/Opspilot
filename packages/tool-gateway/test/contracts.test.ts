import { describe, expect, it } from 'vitest';

import {
  getServiceTopologyInputSchema,
  getServiceTopologyOutputSchema,
  queryLogsInputSchema,
  queryLogsOutputSchema,
  queryMetricsInputSchema,
  queryMetricsOutputSchema,
  searchRunbookInputSchema,
  searchRunbookOutputSchema,
} from '../src/index.js';

describe('Connector contracts', () => {
  it('keeps strict input schemas for all native Connector capabilities', () => {
    expect(
      queryLogsInputSchema.safeParse({
        service: 'billing-api',
        startTime: '2026-08-13T10:15:00.000Z',
        endTime: '2026-08-13T10:00:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      queryMetricsInputSchema.safeParse({
        service: 'billing-api',
        metric: 'arbitrary_promql',
        startTime: '2026-08-13T10:00:00.000Z',
        endTime: '2026-08-13T10:15:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      searchRunbookInputSchema.safeParse({ service: 'billing-api', query: '', extra: true })
        .success,
    ).toBe(false);
    expect(getServiceTopologyInputSchema.safeParse({ service: 'billing-api', extra: true }).success).toBe(
      false,
    );
  });

  it('keeps strict output schemas with source metadata and no evidence mapping', () => {
    const common = {
      summary: 'fixture result',
      sourceUri: 'fixture://test/result',
    };
    expect(
      queryLogsOutputSchema.safeParse({
        ...common,
        entries: [],
        count: 0,
        timeRangeStart: '2026-08-13T10:00:00.000Z',
        timeRangeEnd: '2026-08-13T10:15:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      queryMetricsOutputSchema.safeParse({
        ...common,
        metric: 'http_error_rate',
        unit: 'ratio',
        samples: [],
        timeRangeStart: '2026-08-13T10:00:00.000Z',
        timeRangeEnd: '2026-08-13T10:15:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      searchRunbookOutputSchema.safeParse({ ...common, title: 'Runbook', excerpts: ['Step 1'] })
        .success,
    ).toBe(true);
    expect(
      getServiceTopologyOutputSchema.safeParse({
        ...common,
        service: 'billing-api',
        upstream: [],
        downstream: [],
      }).success,
    ).toBe(true);
    expect(
      getServiceTopologyOutputSchema.safeParse({
        ...common,
        service: 'billing-api',
        upstream: [],
        downstream: [],
        evidenceKind: 'TOPOLOGY',
      }).success,
    ).toBe(false);
  });
});
