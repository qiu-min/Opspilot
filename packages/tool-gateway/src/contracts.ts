import { z } from 'zod';

export const toolNameSchema = z.enum([
  'queryLogs',
  'queryMetrics',
  'searchRunbook',
  'getServiceTopology',
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const evidenceKindSchema = z.enum(['LOGS', 'METRICS', 'RUNBOOK', 'TOPOLOGY']);
export type ToolEvidenceKind = z.infer<typeof evidenceKindSchema>;

const dateRangeFields = {
  startTime: z.string().datetime({ offset: true }),
  endTime: z.string().datetime({ offset: true }),
};
const serviceSchema = z.string().trim().min(1).max(100);

export const queryLogsInputSchema = z
  .object({ service: serviceSchema, ...dateRangeFields, query: z.string().trim().min(1).max(200).optional() })
  .strict()
  .refine((value) => value.startTime <= value.endTime, { message: 'startTime must not be after endTime.' });

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
  .object({ service: serviceSchema, metric: supportedMetricSchema, ...dateRangeFields })
  .strict()
  .refine((value) => value.startTime <= value.endTime, { message: 'startTime must not be after endTime.' });

export const searchRunbookInputSchema = z.object({ service: serviceSchema, query: z.string().trim().min(1).max(200) }).strict();
export const getServiceTopologyInputSchema = z.object({ service: serviceSchema }).strict();

export const toolCallSchema = z.object({
  callId: z.string().trim().min(1).max(200),
  name: toolNameSchema,
  arguments: z.unknown(),
}).strict();
export type ToolCall = z.infer<typeof toolCallSchema>;

export const logEntrySchema = z.object({ timestamp: z.string().datetime({ offset: true }), service: z.string(), level: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']), message: z.string(), attributes: z.record(z.string(), z.unknown()).optional() }).strict();
export const metricSampleSchema = z.object({ timestamp: z.string().datetime({ offset: true }), value: z.number() }).strict();
export const queryLogsOutputSchema = z.object({ entries: z.array(logEntrySchema), count: z.number().int().nonnegative() }).strict();
export const queryMetricsOutputSchema = z.object({ metric: supportedMetricSchema, unit: z.string().min(1), samples: z.array(metricSampleSchema) }).strict();
export const searchRunbookOutputSchema = z.object({ title: z.string().min(1), excerpts: z.array(z.string().min(1)).min(1) }).strict();
export const getServiceTopologyOutputSchema = z.object({ service: z.string().min(1), upstream: z.array(z.string()), downstream: z.array(z.object({ service: z.string(), relation: z.string() }).strict()) }).strict();

export interface ToolDefinition<TInput extends z.ZodType = z.ZodType, TOutput extends z.ZodType = z.ZodType> {
  readonly name: ToolName;
  readonly description: string;
  readonly inputSchema: TInput;
  readonly outputSchema: TOutput;
  readonly evidenceKind: ToolEvidenceKind;
  readonly readOnly: true;
}

export const toolDefinitions = [
  { name: 'queryLogs', description: 'Search service logs in an inclusive UTC time range, optionally by keyword.', inputSchema: queryLogsInputSchema, outputSchema: queryLogsOutputSchema, evidenceKind: 'LOGS', readOnly: true },
  { name: 'queryMetrics', description: 'Read one supported service metric in an inclusive UTC time range.', inputSchema: queryMetricsInputSchema, outputSchema: queryMetricsOutputSchema, evidenceKind: 'METRICS', readOnly: true },
  { name: 'searchRunbook', description: 'Search the service runbook and return matching excerpts.', inputSchema: searchRunbookInputSchema, outputSchema: searchRunbookOutputSchema, evidenceKind: 'RUNBOOK', readOnly: true },
  { name: 'getServiceTopology', description: 'Return the service upstream and downstream dependencies.', inputSchema: getServiceTopologyInputSchema, outputSchema: getServiceTopologyOutputSchema, evidenceKind: 'TOPOLOGY', readOnly: true },
] as const satisfies readonly ToolDefinition[];

export const toolErrorCodeSchema = z.enum(['UNKNOWN_TOOL', 'INVALID_ARGUMENTS', 'UNKNOWN_SERVICE', 'NO_MATCHING_DATA']);
export type ToolErrorCode = z.infer<typeof toolErrorCodeSchema>;
export interface ToolSuccessResult { readonly ok: true; readonly callId: string; readonly name: ToolName; readonly data: unknown; readonly summary: string; readonly sourceUri: string; readonly timeRangeStart?: string; readonly timeRangeEnd?: string; }
export interface ToolFailureResult { readonly ok: false; readonly callId: string; readonly name: string; readonly errorCode: ToolErrorCode; readonly message: string; }
export type ToolResult = ToolSuccessResult | ToolFailureResult;

export interface ToolGateway { listTools(): readonly ToolDefinition[]; execute(call: ToolCall): Promise<ToolResult>; }
