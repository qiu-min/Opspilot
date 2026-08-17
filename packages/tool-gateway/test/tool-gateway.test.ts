import { describe, expect, it } from 'vitest';

import { FixtureToolGateway } from '../src/index.js';

const gateway = new FixtureToolGateway();
const connectionRange = { startTime: '2026-08-13T10:00:00.000Z', endTime: '2026-08-13T10:15:00.000Z' };

describe('FixtureToolGateway', () => {
  it('filters logs and returns an agent-readable error summary', async () => {
    const result = await gateway.execute({ callId: 'logs-1', name: 'queryLogs', arguments: { service: 'billing-api', ...connectionRange, query: 'timeout' } });
    expect(result).toMatchObject({ ok: true, callId: 'logs-1', name: 'queryLogs', sourceUri: 'fixture://connection-pool/logs' });
    if (result.ok) {
      expect(result.summary).toContain('database connection acquisition timeout');
      expect((result.data as { count: number }).count).toBe(2);
    }
  });

  it('returns only the requested metric and range', async () => {
    const result = await gateway.execute({ callId: 'metric-1', name: 'queryMetrics', arguments: { service: 'orders-api', metric: 'http_latency_p99', startTime: '2026-08-13T12:07:00.000Z', endTime: '2026-08-13T12:10:00.000Z' } });
    expect(result).toMatchObject({ ok: true, callId: 'metric-1', name: 'queryMetrics', sourceUri: 'fixture://latency/metrics' });
    if (result.ok) expect(result.data).toEqual({ metric: 'http_latency_p99', unit: 'milliseconds', samples: [{ timestamp: '2026-08-13T12:08:00.000Z', value: 3300 }] });
  });

  it('returns matching runbook excerpts and topology', async () => {
    const runbook = await gateway.execute({ callId: 'runbook-1', name: 'searchRunbook', arguments: { service: 'checkout-api', query: '5xx' } });
    const checkoutLogs = await gateway.execute({ callId: 'checkout-logs', name: 'queryLogs', arguments: { service: 'checkout-api', startTime: '2026-08-13T11:00:00.000Z', endTime: '2026-08-13T11:15:00.000Z', query: '502' } });
    const topology = await gateway.execute({ callId: 'topology-1', name: 'getServiceTopology', arguments: { service: 'orders-api' } });
    expect(runbook).toMatchObject({ ok: true, callId: 'runbook-1', sourceUri: 'fixture://error-rate/runbook' });
    expect(checkoutLogs).toMatchObject({ ok: true, callId: 'checkout-logs', sourceUri: 'fixture://error-rate/logs' });
    expect(topology).toMatchObject({ ok: true, callId: 'topology-1', sourceUri: 'fixture://latency/topology' });
  });

  it('returns safe, structured failures without throwing', async () => {
    const [unknownTool, invalidArguments, unknownService, noMatch] = await Promise.all([
      gateway.execute({ callId: 'unknown-tool', name: 'not-real' as never, arguments: {} }),
      gateway.execute({ callId: 'bad-input', name: 'queryLogs', arguments: { service: 'billing-api' } }),
      gateway.execute({ callId: 'unknown-service', name: 'getServiceTopology', arguments: { service: 'missing-api' } }),
      gateway.execute({ callId: 'no-match', name: 'searchRunbook', arguments: { service: 'billing-api', query: 'unrelated phrase' } }),
    ]);
    expect(unknownTool).toMatchObject({ ok: false, callId: 'unknown-tool', errorCode: 'UNKNOWN_TOOL' });
    expect(invalidArguments).toMatchObject({ ok: false, callId: 'bad-input', errorCode: 'INVALID_ARGUMENTS' });
    expect(unknownService).toMatchObject({ ok: false, callId: 'unknown-service', errorCode: 'UNKNOWN_SERVICE' });
    expect(noMatch).toMatchObject({ ok: false, callId: 'no-match', errorCode: 'NO_MATCHING_DATA' });
  });

  it('is deterministic and keeps callId only as correlation metadata', async () => {
    const first = await gateway.execute({ callId: 'first', name: 'getServiceTopology', arguments: { service: 'checkout-api' } });
    const second = await gateway.execute({ callId: 'second', name: 'getServiceTopology', arguments: { service: 'checkout-api' } });
    expect(first).toMatchObject({ ok: true, callId: 'first' });
    expect(second).toMatchObject({ ok: true, callId: 'second' });
    if (first.ok && second.ok) expect({ ...first, callId: '' }).toEqual({ ...second, callId: '' });
  });
});
