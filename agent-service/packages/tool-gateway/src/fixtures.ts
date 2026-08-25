import connectionPoolLogs from './fixtures/connection-pool/logs.json' with { type: 'json' };
import connectionPoolMetrics from './fixtures/connection-pool/metrics.json' with { type: 'json' };
import connectionPoolTopology from './fixtures/connection-pool/topology.json' with { type: 'json' };
import errorRateLogs from './fixtures/error-rate/logs.json' with { type: 'json' };
import errorRateMetrics from './fixtures/error-rate/metrics.json' with { type: 'json' };
import errorRateTopology from './fixtures/error-rate/topology.json' with { type: 'json' };
import latencyLogs from './fixtures/latency/logs.json' with { type: 'json' };
import latencyMetrics from './fixtures/latency/metrics.json' with { type: 'json' };
import latencyTopology from './fixtures/latency/topology.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { z } from 'zod';


const timestampSchema = z.string().datetime({ offset: true });
const logEntrySchema = z.object({
  timestamp: timestampSchema,
  service: z.string().min(1),
  level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
  message: z.string().min(1),
  attributes: z.record(z.string(), z.unknown()).optional(),
}).strict();
const metricSeriesSchema = z.object({
  service: z.string().min(1),
  metric: z.string().min(1),
  unit: z.string().min(1),
  samples: z.array(z.object({ timestamp: timestampSchema, value: z.number() }).strict()).min(1),
}).strict();
const topologySchema = z.object({
  service: z.string().min(1),
  upstream: z.array(z.string().min(1)),
  downstream: z.array(z.object({ service: z.string().min(1), relation: z.string().min(1) }).strict()),
}).strict();

export type FixtureLogEntry = z.infer<typeof logEntrySchema>;
export type FixtureMetricSeries = z.infer<typeof metricSeriesSchema>;
export type FixtureTopology = z.infer<typeof topologySchema>;

export interface FixtureScenario {
  readonly id: 'connection-pool' | 'error-rate' | 'latency';
  readonly service: string;
  readonly logs: readonly FixtureLogEntry[];
  readonly metrics: readonly FixtureMetricSeries[];
  readonly topology: FixtureTopology;
  readonly runbook: { readonly title: string; readonly markdown: string; readonly sourceUri: string };
  readonly sourceUris: { readonly logs: string; readonly metrics: string; readonly topology: string };
}

/** 读取 Fixture Runbook Markdown 内容。
 * @param relativePath 相对于当前模块的 Markdown 路径。
 * @returns 去除首尾空白后的 Markdown 内容。
 */
function loadMarkdown(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8').trim();
}

/** 校验并组装一个完整 Fixture 场景。
 * @param input 场景元数据及未校验的日志、指标和拓扑数据。
 * @returns 通过一致性校验的 Fixture 场景。
 */
function scenario(input: Omit<FixtureScenario, 'logs' | 'metrics' | 'topology'> & { logs: unknown; metrics: unknown; topology: unknown }): FixtureScenario {
  const logs = z.array(logEntrySchema).min(1).parse(input.logs);
  const metrics = z.array(metricSeriesSchema).min(1).parse(input.metrics);
  const topology = topologySchema.parse(input.topology);
  if (topology.service !== input.service || logs.some((entry) => entry.service !== input.service) || metrics.some((series) => series.service !== input.service)) {
    throw new Error(`Fixture ${input.id} has inconsistent service names.`);
  }
  return { ...input, logs, metrics, topology };
}

export const fixtureScenarios: readonly FixtureScenario[] = [
  scenario({ id: 'connection-pool', service: 'billing-api', logs: connectionPoolLogs, metrics: connectionPoolMetrics, topology: connectionPoolTopology, runbook: { title: 'Billing API database connection pool investigation', markdown: loadMarkdown('./fixtures/connection-pool/runbook.md'), sourceUri: 'fixture://connection-pool/runbook' }, sourceUris: { logs: 'fixture://connection-pool/logs', metrics: 'fixture://connection-pool/metrics', topology: 'fixture://connection-pool/topology' } }),
  scenario({ id: 'error-rate', service: 'checkout-api', logs: errorRateLogs, metrics: errorRateMetrics, topology: errorRateTopology, runbook: { title: 'Checkout API error-rate investigation', markdown: loadMarkdown('./fixtures/error-rate/runbook.md'), sourceUri: 'fixture://error-rate/runbook' }, sourceUris: { logs: 'fixture://error-rate/logs', metrics: 'fixture://error-rate/metrics', topology: 'fixture://error-rate/topology' } }),
  scenario({ id: 'latency', service: 'orders-api', logs: latencyLogs, metrics: latencyMetrics, topology: latencyTopology, runbook: { title: 'Orders API latency investigation', markdown: loadMarkdown('./fixtures/latency/runbook.md'), sourceUri: 'fixture://latency/runbook' }, sourceUris: { logs: 'fixture://latency/logs', metrics: 'fixture://latency/metrics', topology: 'fixture://latency/topology' } }),
];

/** 按服务名称查找 Fixture 场景。
 * @param service 要查找的服务名称。
 * @returns 匹配的 Fixture 场景，找不到时返回 undefined。
 */
export function findFixtureScenario(service: string): FixtureScenario | undefined {
  return fixtureScenarios.find((scenario) => scenario.service === service);
}
