import { describe, expect, it } from 'vitest';
import { fixtureScenarios } from '../src/fixtures.js';

describe('Day 6 fixture scenarios', () => {
  it('loads three complete, internally consistent scenarios', () => {
    expect(fixtureScenarios.map((scenario) => scenario.service)).toEqual([
      'billing-api',
      'checkout-api',
      'orders-api',
    ]);
    for (const scenario of fixtureScenarios) {
      expect(scenario.logs.length).toBeGreaterThan(0);
      expect(scenario.metrics.length).toBeGreaterThan(0);
      expect(scenario.topology.service).toBe(scenario.service);
      expect(scenario.runbook.markdown.length).toBeGreaterThan(20);
      expect(Object.values(scenario.sourceUris).every((uri) => uri.startsWith('fixture://'))).toBe(true);
      expect(scenario.runbook.sourceUri.startsWith('fixture://')).toBe(true);
    }
  });

  it('contains the distinct evidence needed for every scenario', () => {
    const billing = fixtureScenarios[0]!;
    const checkout = fixtureScenarios[1]!;
    const orders = fixtureScenarios[2]!;
    expect(billing.logs.some((entry) => entry.message.includes('acquisition timeout'))).toBe(true);
    expect(billing.metrics.map((series) => series.metric)).toEqual(expect.arrayContaining(['db_connection_active', 'db_connection_idle', 'db_connection_max']));
    expect(checkout.logs.some((entry) => entry.attributes?.statusCode === 502)).toBe(true);
    expect(checkout.metrics.map((series) => series.metric)).toEqual(expect.arrayContaining(['http_error_rate', 'http_request_rate']));
    expect(orders.logs.some((entry) => entry.message.includes('slow request'))).toBe(true);
    expect(orders.metrics.map((series) => series.metric)).toEqual(expect.arrayContaining(['http_latency_p95', 'http_latency_p99', 'dependency_latency_p95']));
  });
});
