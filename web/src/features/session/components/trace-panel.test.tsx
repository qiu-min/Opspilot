import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModelReliabilityDetails, TracePanel, formatTraceDuration, formatTraceIdentifier, getTraceSpanDetails, getTraceSpanLabel, getTraceSummary, groupTraceSpansByAttempt } from "./trace-panel";
import type { ModelTraceErrorResponse, TraceSpanResponse, TurnTraceResponse } from "../../../api/sessions/turn-trace-contracts";

const modelSpan: Extract<TraceSpanResponse, { kind: "model" }> = {
  id: "model:model-call-A",
  kind: "model",
  attempt: 1,
  status: "completed",
  startSequence: 1,
  endSequence: 2,
  startedAt: "2026-09-09T00:00:00Z",
  endedAt: "2026-09-09T00:00:01Z",
  durationMs: 1_000,
  modelCallId: "model-call-A",
  usage: { inputTokens: 1_000, outputTokens: 1_250, totalTokens: 2_250 },
  error: null,
  retries: [],
};

const rateLimitError: ModelTraceErrorResponse = {
  kind: "rate_limit",
  code: "MODEL_RATE_LIMIT",
  message: "Model provider rate limit exceeded.",
  retryable: true,
  statusCode: 429,
  providerCode: "provider_rate_limit",
};

const retriedModelSpan: Extract<TraceSpanResponse, { kind: "model" }> = {
  ...modelSpan,
  retries: [
    { failedAttempt: 1, nextAttempt: 2, delayMs: 500, error: rateLimitError, timestamp: "2026-09-09T00:00:00.500Z" },
    { failedAttempt: 2, nextAttempt: 3, delayMs: 1_000, error: { ...rateLimitError, kind: "timeout", code: "MODEL_TIMEOUT", providerCode: null, statusCode: null }, timestamp: "2026-09-09T00:00:01.500Z" },
  ],
};

const finalFailure: ModelTraceErrorResponse = {
  kind: "server_error",
  code: "MODEL_SERVER_ERROR",
  message: "Model provider request failed.",
  retryable: true,
  statusCode: 503,
  providerCode: "provider_unavailable",
};

const toolSpan: TraceSpanResponse = {
  id: "tool:call-A:attempt:1",
  kind: "tool",
  attempt: 1,
  status: "completed",
  startSequence: 3,
  endSequence: 4,
  startedAt: "2026-09-09T00:00:01Z",
  endedAt: "2026-09-09T00:00:02Z",
  durationMs: 1_000,
  callId: "call-A",
  name: "get_sheet_profile",
  requestedAt: "2026-09-09T00:00:01Z",
  isError: false,
};

const compactionSpan: TraceSpanResponse = {
  id: "compaction:5",
  kind: "compaction",
  attempt: 1,
  status: "incomplete",
  startSequence: 5,
  endSequence: null,
  startedAt: "2026-09-09T00:00:02Z",
  endedAt: null,
  durationMs: null,
  entryId: "entry-1",
  sessionLeafId: "leaf-1",
};

const trace: TurnTraceResponse = {
  turnId: "turn-1",
  sessionId: "session-1",
  status: "completed",
  startedAt: "2026-09-09T00:00:00Z",
  endedAt: "2026-09-09T00:00:05Z",
  durationMs: 5_000,
  spans: [modelSpan, toolSpan, compactionSpan],
};

describe("TracePanel helpers", () => {
  it("derives summary metrics and preserves recovery attempt grouping", () => {
    const recoveryModel = { ...modelSpan, id: "model:model-call-B", modelCallId: "model-call-B", attempt: 2 };
    expect(getTraceSummary([...trace.spans, recoveryModel])).toEqual({ modelCallCount: 2, toolCallCount: 1, totalTokens: 4_500, attemptCount: 2, retryCount: 0 });
    expect(groupTraceSpansByAttempt([...trace.spans, recoveryModel])).toEqual([
      { attempt: 1, spans: [modelSpan, toolSpan, compactionSpan] },
      { attempt: 2, spans: [recoveryModel] },
    ]);
  });

  it("counts retries across logical model spans", () => {
    expect(getTraceSummary([retriedModelSpan, toolSpan]).retryCount).toBe(2);
  });

  it("uses shared tool labels and exposes detail fields for every span kind", () => {
    expect(getTraceSpanLabel(modelSpan)).toBe("Model call");
    expect(getTraceSpanLabel(toolSpan)).toBe("Get Sheet Profile");
    expect(getTraceSpanLabel(compactionSpan)).toBe("Context compaction");
    expect(getTraceSpanDetails(modelSpan).map((detail) => detail.label)).toEqual(expect.arrayContaining(["Model call ID", "Input tokens", "Output tokens", "Total tokens"]));
    expect(getTraceSpanDetails(toolSpan).map((detail) => detail.label)).toEqual(expect.arrayContaining(["Call ID", "Name", "Requested", "Error"]));
    expect(getTraceSpanDetails(compactionSpan).map((detail) => detail.label)).toEqual(expect.arrayContaining(["Entry ID", "Session leaf ID"]));
    expect(formatTraceDuration(null)).toBe("—");
    expect(formatTraceIdentifier("model-call-123456dc4e")).toBe("model-call…dc4e");
    expect(formatTraceIdentifier("short-id")).toBe("short-id");
  });
});

describe("TracePanel", () => {
  it("renders model, tool, compaction, and recovery attempts", () => {
    const recoveryTrace = { ...trace, spans: [...trace.spans, { ...modelSpan, id: "model:model-call-B", modelCallId: "model-call-B", attempt: 2 }] };
    const markup = renderToStaticMarkup(<TracePanel turnId="turn-1" trace={recoveryTrace} isLoading={false} error={null} onRefresh={vi.fn()} onBack={vi.fn()} />);
    expect(markup).toContain("Developer trace");
    expect(markup).toContain("Model call");
    expect(markup).toContain("Get Sheet Profile");
    expect(markup).toContain("Context compaction");
    expect(markup).toContain("Attempt 1");
    expect(markup).toContain("Attempt 2");
    expect(markup).toContain("Incomplete");
  });

  it("shows retry history and successful recovery without a final failure", () => {
    const collapsed = renderToStaticMarkup(<TracePanel turnId="turn-1" trace={{ ...trace, spans: [retriedModelSpan] }} isLoading={false} error={null} onRefresh={vi.fn()} />);
    const expanded = renderToStaticMarkup(<ModelReliabilityDetails span={retriedModelSpan} />);

    expect(collapsed).toContain("2 retries");
    expect(expanded).toContain("Retry history");
    expect(expanded).toContain("Retry 1 → 2");
    expect(expanded).toContain("Retry 2 → 3");
    expect(expanded).toContain("Rate limited");
    expect(expanded).toContain("Request timed out");
    expect(expanded).toContain("Final result succeeded");
    expect(expanded).not.toContain("Final failure");
  });

  it("shows final failure after retries and omits absent diagnostics", () => {
    const failed = { ...retriedModelSpan, status: "error" as const, error: finalFailure };
    const markup = renderToStaticMarkup(<ModelReliabilityDetails span={failed} />);

    expect(markup).toContain("Previous retries");
    expect(markup).toContain("Final failure");
    expect(markup).toContain("Provider server error");
    expect(markup).toContain("MODEL_SERVER_ERROR");
    expect(markup).toContain("Model provider request failed.");
    expect(markup).toContain("HTTP 503");
    expect(markup).toContain("provider_unavailable");
    expect(markup).toContain("Yes");

    const noDiagnostics = renderToStaticMarkup(<ModelReliabilityDetails span={{ ...modelSpan, error: { ...finalFailure, statusCode: null, providerCode: null } }} />);
    expect(noDiagnostics).not.toContain("HTTP status");
    expect(noDiagnostics).not.toContain("Provider code");
    expect(noDiagnostics).not.toContain("undefined");
    expect(noDiagnostics).not.toContain("null");
  });

  it("shortens long timeline identifiers while keeping full detail values", () => {
    const longModelId = "model-call-123456dc4e";
    const longCallId = "call-abcdefghijklz5649";
    const longModel = { ...modelSpan, id: `model:${longModelId}`, modelCallId: longModelId };
    const longTool = { ...toolSpan, id: `tool:${longCallId}:attempt:1`, callId: longCallId };
    const markup = renderToStaticMarkup(<TracePanel turnId="turn-1" trace={{ ...trace, spans: [longModel, longTool] }} isLoading={false} error={null} onRefresh={vi.fn()} />);

    expect(markup).toContain("model-call…dc4e");
    expect(markup).toContain("call-abcde…5649");
    expect(markup).not.toContain(longModelId);
    expect(markup).not.toContain(longCallId);
    expect(getTraceSpanDetails(longModel).some((detail) => detail.value === longModelId)).toBe(true);
    expect(getTraceSpanDetails(longTool).some((detail) => detail.value === longCallId)).toBe(true);
  });

  it("renders loading, empty, and retryable error states", () => {
    const loading = renderToStaticMarkup(<TracePanel turnId="turn-1" trace={null} isLoading={true} error={null} onRefresh={vi.fn()} />);
    const empty = renderToStaticMarkup(<TracePanel turnId="turn-1" trace={{ ...trace, spans: [], status: "running" }} isLoading={false} error={null} onRefresh={vi.fn()} />);
    const error = renderToStaticMarkup(<TracePanel turnId="turn-1" trace={null} isLoading={false} error={new Error("network") } onRefresh={vi.fn()} />);
    expect(loading).toContain("aria-label=\"Loading trace\"");
    expect(empty).toContain("No execution spans recorded yet.");
    expect(empty).toContain("Execution details will appear as durable events are recorded.");
    expect(error).toContain("Unable to load trace.");
    expect(error).toContain("Retry");
  });
});
