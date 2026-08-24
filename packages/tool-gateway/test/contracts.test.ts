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

  it('compares input time ranges by timestamp across timezone offsets', () => {
    const validRange = {
      startTime: '2026-08-13T10:00:00+08:00',
      endTime: '2026-08-13T03:00:00Z',
    };
    const invalidRange = {
      startTime: '2026-08-13T12:00:00+08:00',
      endTime: '2026-08-13T03:00:00Z',
    };

    expect(
      queryLogsInputSchema.safeParse({ service: 'billing-api', ...validRange }).success,
    ).toBe(true);
    expect(
      queryMetricsInputSchema.safeParse({
        service: 'billing-api',
        metric: 'http_error_rate',
        ...validRange,
      }).success,
    ).toBe(true);
    expect(
      queryLogsInputSchema.safeParse({ service: 'billing-api', ...invalidRange }).success,
    ).toBe(false);
    expect(
      queryMetricsInputSchema.safeParse({
        service: 'billing-api',
        metric: 'http_error_rate',
        ...invalidRange,
      }).success,
    ).toBe(false);
  });

  it('requires non-empty output collections and consistent log counts', () => {
    const common = {
      summary: 'fixture result',
      sourceUri: 'fixture://test/result',
    };
    const logEntry = {
      timestamp: '2026-08-13T10:00:00.000Z',
      service: 'billing-api',
      level: 'INFO' as const,
      message: 'request completed',
    };
    const timeRange = {
      timeRangeStart: '2026-08-13T10:00:00.000Z',
      timeRangeEnd: '2026-08-13T10:15:00.000Z',
    };

    expect(
      queryLogsOutputSchema.safeParse({
        ...common,
        ...timeRange,
        entries: [logEntry],
        count: 1,
      }).success,
    ).toBe(true);
    expect(
      queryLogsOutputSchema.safeParse({
        ...common,
        ...timeRange,
        entries: [logEntry],
        count: 999,
      }).success,
    ).toBe(false);
    expect(
      queryLogsOutputSchema.safeParse({
        ...common,
        ...timeRange,
        entries: [],
        count: 0,
      }).success,
    ).toBe(false);
    expect(
      queryMetricsOutputSchema.safeParse({
        ...common,
        ...timeRange,
        metric: 'http_error_rate',
        unit: 'ratio',
        samples: [],
      }).success,
    ).toBe(false);
    expect(
      queryMetricsOutputSchema.safeParse({
        ...common,
        ...timeRange,
        metric: 'http_error_rate',
        unit: 'ratio',
        samples: [{ timestamp: '2026-08-13T10:00:00.000Z', value: 0.1 }],
      }).success,
    ).toBe(true);
  });

  it('keeps valid Runbook and topology outputs strict', () => {
    const common = {
      summary: 'fixture result',
      sourceUri: 'fixture://test/result',
    };
    expect(
      searchRunbookOutputSchema.safeParse({
        ...common,
        title: 'Runbook',
        excerpts: ['Step 1'],
      }).success,
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
