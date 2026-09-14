import { afterEach, describe, expect, it, vi } from "vitest";
import { getSessionTurnTrace } from "./session-api";

describe("getSessionTurnTrace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the session Turn trace and returns all span kinds", async () => {
    const trace = {
      turnId: "turn-1",
      sessionId: "session-1",
      status: "completed",
      startedAt: "2026-09-09T00:00:00Z",
      endedAt: "2026-09-09T00:00:05Z",
      durationMs: 5_000,
      spans: [
        {
          id: "model:model-call-A",
          kind: "model",
          attempt: 1,
          status: "completed",
          startSequence: 1,
          endSequence: 2,
          startedAt: "2026-09-09T00:00:01Z",
          endedAt: "2026-09-09T00:00:02Z",
          durationMs: 1_000,
          modelCallId: "model-call-A",
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          error: null,
          retries: [],
        },
        {
          id: "tool:call-A:attempt:1",
          kind: "tool",
          attempt: 1,
          status: "completed",
          startSequence: 3,
          endSequence: 4,
          startedAt: "2026-09-09T00:00:02Z",
          endedAt: "2026-09-09T00:00:03Z",
          durationMs: 1_000,
          callId: "call-A",
          name: "get_sheet_profile",
          requestedAt: "2026-09-09T00:00:02Z",
          isError: false,
        },
        {
          id: "compaction:5",
          kind: "compaction",
          attempt: 1,
          status: "completed",
          startSequence: 5,
          endSequence: 6,
          startedAt: "2026-09-09T00:00:03Z",
          endedAt: "2026-09-09T00:00:04Z",
          durationMs: 1_000,
          entryId: "entry-1",
          sessionLeafId: "leaf-1",
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(trace), { headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const signalController = new AbortController();

    await expect(getSessionTurnTrace("session/1", "turn/1", "access-token", signalController.signal)).resolves.toEqual(trace);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/session%2F1/turns/turn%2F1/trace");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      signal: signalController.signal,
    });
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("Accept")).toBe("application/json");
    expect(requestHeaders.get("Authorization")).toBe("Bearer access-token");
  });
});
