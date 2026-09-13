import { afterEach, describe, expect, it, vi } from "vitest";
import { TRACE_REFRESH_INTERVAL_MS, pollTurnTrace } from "./use-turn-trace";
import type { TurnTraceResponse } from "../../api/sessions/turn-trace-contracts";

const baseTrace: TurnTraceResponse = {
  turnId: "turn-1",
  sessionId: "session-1",
  status: "running",
  startedAt: "2026-09-09T00:00:00Z",
  endedAt: null,
  durationMs: null,
  spans: [],
};

afterEach(() => vi.useRealTimers());

describe("pollTurnTrace", () => {
  it("refreshes a running trace and stops immediately after completion", async () => {
    vi.useFakeTimers();
    const loadTrace = vi.fn()
      .mockResolvedValueOnce(baseTrace)
      .mockResolvedValueOnce({ ...baseTrace, status: "completed", endedAt: "2026-09-09T00:00:01Z", durationMs: 1_000 });
    const controller = new AbortController();
    const received: TurnTraceResponse[] = [];

    const polling = pollTurnTrace(loadTrace, controller.signal, (trace) => received.push(trace));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadTrace).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(TRACE_REFRESH_INTERVAL_MS);
    await polling;

    expect(loadTrace).toHaveBeenCalledTimes(2);
    expect(received.map((trace) => trace.status)).toEqual(["running", "completed"]);
    await vi.advanceTimersByTimeAsync(TRACE_REFRESH_INTERVAL_MS * 2);
    expect(loadTrace).toHaveBeenCalledTimes(2);
  });

  it("stops waiting when the selected panel is closed", async () => {
    vi.useFakeTimers();
    const loadTrace = vi.fn().mockResolvedValue(baseTrace);
    const controller = new AbortController();
    const received: TurnTraceResponse[] = [];
    const polling = pollTurnTrace(loadTrace, controller.signal, (trace) => received.push(trace));

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await polling;
    await vi.advanceTimersByTimeAsync(TRACE_REFRESH_INTERVAL_MS * 2);

    expect(loadTrace).toHaveBeenCalledOnce();
    expect(received).toHaveLength(1);
  });
});
