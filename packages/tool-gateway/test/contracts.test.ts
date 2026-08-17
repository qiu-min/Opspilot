import { describe, expect, it } from 'vitest';

import {
  getServiceTopologyInputSchema,
  queryLogsInputSchema,
  queryMetricsInputSchema,
  searchRunbookInputSchema,
  toolDefinitions,
} from '../src/index.js';

describe('tool contracts', () => {
  it('defines four unique, read-only tools with their expected evidence kinds', () => {
    expect(toolDefinitions.map((tool) => tool.name)).toEqual([
      'queryLogs',
      'queryMetrics',
      'searchRunbook',
      'getServiceTopology',
    ]);
    expect(toolDefinitions.map((tool) => tool.evidenceKind)).toEqual([
      'LOGS',
      'METRICS',
      'RUNBOOK',
      'TOPOLOGY',
    ]);
    expect(toolDefinitions.every((tool) => tool.readOnly && tool.description.length > 0)).toBe(true);
  });

  it('rejects invalid ranges, unsupported metrics, and extra fields', () => {
    expect(queryLogsInputSchema.safeParse({ service: 'billing-api', startTime: '2026-08-13T10:15:00.000Z', endTime: '2026-08-13T10:00:00.000Z' }).success).toBe(false);
    expect(queryMetricsInputSchema.safeParse({ service: 'billing-api', metric: 'arbitrary_promql', startTime: '2026-08-13T10:00:00.000Z', endTime: '2026-08-13T10:15:00.000Z' }).success).toBe(false);
    expect(searchRunbookInputSchema.safeParse({ service: 'billing-api', query: '', extra: true }).success).toBe(false);
    expect(getServiceTopologyInputSchema.safeParse({ service: 'billing-api', extra: true }).success).toBe(false);
  });
});
