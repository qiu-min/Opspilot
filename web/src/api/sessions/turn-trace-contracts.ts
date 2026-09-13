export type TurnTraceStatus = "running" | "completed" | "failed" | "cancelled";

export type TraceSpanStatus = "completed" | "incomplete" | "error";

export type TraceSpanBase = {
  id: string;
  kind: "model" | "tool" | "compaction";
  attempt: number;
  status: TraceSpanStatus;
  startSequence: number | null;
  endSequence: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
};

export type TraceUsageResponse = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ModelTraceSpanResponse = TraceSpanBase & {
  kind: "model";
  modelCallId: string;
  usage: TraceUsageResponse | null;
};

export type ToolTraceSpanResponse = TraceSpanBase & {
  kind: "tool";
  callId: string;
  name: string;
  requestedAt: string | null;
  isError: boolean;
};

export type CompactionTraceSpanResponse = TraceSpanBase & {
  kind: "compaction";
  entryId?: string;
  sessionLeafId?: string | null;
};

export type TraceSpanResponse = ModelTraceSpanResponse | ToolTraceSpanResponse | CompactionTraceSpanResponse;

export type TurnTraceResponse = {
  turnId: string;
  sessionId: string;
  status: TurnTraceStatus;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  spans: TraceSpanResponse[];
};
