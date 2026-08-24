import { z } from 'zod';

const timestampSchema = z.string().datetime({ offset: true });
const serviceSchema = z.string().trim().min(1).max(100);
const sourceUriSchema = z.string().trim().min(1);
const summarySchema = z.string().trim().min(1);

const dateRangeFields = {
  startTime: timestampSchema,
  endTime: timestampSchema,
};

/** 当前 OpsPilot 原生 Connector 对应的工具名称，不限制整个 Agent Runtime。 */
export type NativeOpsToolName =
  | 'queryLogs'
  | 'queryMetrics'
  | 'searchRunbook'
  | 'getServiceTopology';

export const queryLogsInputSchema = z
  .object({
    service: serviceSchema,
    ...dateRangeFields,
    query: z.string().trim().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => value.startTime <= value.endTime, {
    message: 'startTime must not be after endTime.',
  });
export type QueryLogsInput = z.infer<typeof queryLogsInputSchema>;

export const supportedMetricSchema = z.enum([
  'db_connection_active',
  'db_connection_idle',
  'db_connection_max',
  'http_error_rate',
  'http_request_rate',
  'http_latency_p95',
  'http_latency_p99',
  'dependency_latency_p95',
]);
export type SupportedMetric = z.infer<typeof supportedMetricSchema>;

export const queryMetricsInputSchema = z
  .object({
    service: serviceSchema,
    metric: supportedMetricSchema,
    ...dateRangeFields,
  })
  .strict()
  .refine((value) => value.startTime <= value.endTime, {
    message: 'startTime must not be after endTime.',
  });
export type QueryMetricsInput = z.infer<typeof queryMetricsInputSchema>;

export const searchRunbookInputSchema = z
  .object({
    service: serviceSchema,
    query: z.string().trim().min(1).max(200),
  })
  .strict();
export type SearchRunbookInput = z.infer<typeof searchRunbookInputSchema>;

export const getServiceTopologyInputSchema = z
  .object({ service: serviceSchema })
  .strict();
export type GetServiceTopologyInput = z.infer<typeof getServiceTopologyInputSchema>;

const logEntrySchema = z
  .object({
    timestamp: timestampSchema,
    service: z.string().min(1),
    level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']),
    message: z.string().min(1),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const metricSampleSchema = z
  .object({ timestamp: timestampSchema, value: z.number() })
  .strict();

export const queryLogsOutputSchema = z
  .object({
    entries: z.array(logEntrySchema),
    count: z.number().int().nonnegative(),
    summary: summarySchema,
    sourceUri: sourceUriSchema,
    timeRangeStart: timestampSchema,
    timeRangeEnd: timestampSchema,
  })
  .strict();
export type QueryLogsOutput = z.infer<typeof queryLogsOutputSchema>;

export const queryMetricsOutputSchema = z
  .object({
    metric: supportedMetricSchema,
    unit: z.string().min(1),
    samples: z.array(metricSampleSchema),
    summary: summarySchema,
    sourceUri: sourceUriSchema,
    timeRangeStart: timestampSchema,
    timeRangeEnd: timestampSchema,
  })
  .strict();
export type QueryMetricsOutput = z.infer<typeof queryMetricsOutputSchema>;

export const searchRunbookOutputSchema = z
  .object({
    title: z.string().min(1),
    excerpts: z.array(z.string().min(1)).min(1),
    summary: summarySchema,
    sourceUri: sourceUriSchema,
  })
  .strict();
export type SearchRunbookOutput = z.infer<typeof searchRunbookOutputSchema>;

export const getServiceTopologyOutputSchema = z
  .object({
    service: z.string().min(1),
    upstream: z.array(z.string()),
    downstream: z
      .array(
        z
          .object({ service: z.string(), relation: z.string() })
          .strict(),
      ),
    summary: summarySchema,
    sourceUri: sourceUriSchema,
  })
  .strict();
export type GetServiceTopologyOutput = z.infer<typeof getServiceTopologyOutputSchema>;

/** 查询日志的外部能力契约。 */
export interface LogConnector {
  /** 查询指定服务时间范围内的日志。
   * @param input 已校验的日志查询参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns 日志数据及其来源 metadata。
   */
  query(input: QueryLogsInput, signal?: AbortSignal): Promise<QueryLogsOutput>;
}

/** 查询指标的外部能力契约。 */
export interface MetricConnector {
  /** 查询指定服务时间范围内的指标。
   * @param input 已校验的指标查询参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns 指标数据及其来源 metadata。
   */
  query(input: QueryMetricsInput, signal?: AbortSignal): Promise<QueryMetricsOutput>;
}

/** 搜索 Runbook 的外部能力契约。 */
export interface RunbookConnector {
  /** 搜索指定服务的 Runbook 内容。
   * @param input 已校验的 Runbook 搜索参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns Runbook 摘要及其来源 metadata。
   */
  search(input: SearchRunbookInput, signal?: AbortSignal): Promise<SearchRunbookOutput>;
}

/** 查询服务拓扑的外部能力契约。 */
export interface ServiceTopologyConnector {
  /** 获取指定服务的上下游依赖。
   * @param input 已校验的服务拓扑查询参数。
   * @param signal 上游 Agent Run 的取消信号。
   * @returns 拓扑数据及其来源 metadata。
   */
  get(input: GetServiceTopologyInput, signal?: AbortSignal): Promise<GetServiceTopologyOutput>;
}
