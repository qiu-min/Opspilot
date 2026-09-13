import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TracePanel, formatTraceDuration, getTraceSpanDetails, getTraceSpanLabel, getTraceSummary, groupTraceSpansByAttempt } from "./trace-panel";
import type { TraceSpanResponse, TurnTraceResponse } from "../../../api/sessions/turn-trace-contracts";

const modelSpan: TraceSpanResponse = {
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
    expect(getTraceSummary([...trace.spans, recoveryModel])).toEqual({ modelCallCount: 2, toolCallCount: 1, totalTokens: 4_500, attemptCount: 2 });
    expect(groupTraceSpansByAttempt([...trace.spans, recoveryModel])).toEqual([
      { attempt: 1, spans: [modelSpan, toolSpan, compactionSpan] },
      { attempt: 2, spans: [recoveryModel] },
    ]);
  });

  it("uses shared tool labels and exposes detail fields for every span kind", () => {
    expect(getTraceSpanLabel(modelSpan)).toBe("Model call");
    expect(getTraceSpanLabel(toolSpan)).toBe("Get Sheet Profile");
    expect(getTraceSpanLabel(compactionSpan)).toBe("Context compaction");
    expect(getTraceSpanDetails(modelSpan).map((detail) => detail.label)).toEqual(expect.arrayContaining(["Model call ID", "Input tokens", "Output tokens", "Total tokens"]));
    expect(getTraceSpanDetails(toolSpan).map((detail) => detail.label)).toEqual(expect.arrayContaining(["Call ID", "Name", "Requested", "Error"]));
    expect(getTraceSpanDetails(compactionSpan).map((detail) => detail.label)).toEqual(expect.arrayContaining(["Entry ID", "Session leaf ID"]));
    expect(formatTraceDuration(null)).toBe("—");
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
