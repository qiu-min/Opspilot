import { describe, expect, it } from 'vitest';

import {
  FixtureLogConnector,
  FixtureMetricConnector,
  FixtureRunbookConnector,
  FixtureServiceTopologyConnector,
} from '../src/index.js';

const connectionRange = {
  startTime: '2026-08-13T10:00:00.000Z',
  endTime: '2026-08-13T10:15:00.000Z',
};

describe('Fixture connectors', () => {
  it('filters logs by service, time range, and query', async () => {
    const result = await new FixtureLogConnector().query({
      service: 'billing-api',
      ...connectionRange,
      query: 'timeout',
    });

    expect(result.sourceUri).toBe('fixture://connection-pool/logs');
    expect(result.timeRangeStart).toBe(connectionRange.startTime);
    expect(result.timeRangeEnd).toBe(connectionRange.endTime);
    expect(result.summary).toContain('database connection acquisition timeout');
    expect(result.count).toBe(2);
  });

  it('returns only the requested metric and range', async () => {
    const result = await new FixtureMetricConnector().query({
      service: 'orders-api',
      metric: 'http_latency_p99',
      startTime: '2026-08-13T12:07:00.000Z',
      endTime: '2026-08-13T12:10:00.000Z',
    });

    expect(result.sourceUri).toBe('fixture://latency/metrics');
    expect(result.samples).toEqual([
      { timestamp: '2026-08-13T12:08:00.000Z', value: 3300 },
    ]);
  });

  it('returns matching runbook excerpts and topology', async () => {
    const runbook = await new FixtureRunbookConnector().search({
      service: 'checkout-api',
      query: '5xx',
    });
    const topology = await new FixtureServiceTopologyConnector().get({
      service: 'orders-api',
    });

    expect(runbook.sourceUri).toBe('fixture://error-rate/runbook');
    expect(runbook.excerpts.length).toBeGreaterThan(0);
    expect(topology.sourceUri).toBe('fixture://latency/topology');
    expect(topology.service).toBe('orders-api');
  });

  it('throws Connector errors instead of creating ToolResult abstractions', async () => {
    await expect(
      new FixtureLogConnector().query({
        service: 'missing-api',
        ...connectionRange,
      }),
    ).rejects.toThrow('No fixture service named missing-api.');
    await expect(
      new FixtureRunbookConnector().search({
        service: 'billing-api',
        query: 'unrelated phrase',
      }),
    ).rejects.toThrow('No runbook excerpt matched');
  });

  it('honors an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new FixtureServiceTopologyConnector().get({ service: 'billing-api' }, controller.signal),
    ).rejects.toThrow();
  });
});
