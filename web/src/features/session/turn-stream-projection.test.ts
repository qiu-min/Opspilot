import { describe, expect, it } from "vitest";
import { projectTurnStream } from "./turn-stream-projection";
import { createInitialTurnStreamState, reduceTurnStreamEvent } from "./turn-stream-state";

const identity = { turnId: "t", sessionId: "s" };

describe("projectTurnStream", () => {
  it("projects display, timings, aggregated usage, and tool count", () => {
    let state = createInitialTurnStreamState(identity.turnId, identity.sessionId);
    state = reduceTurnStreamEvent(state, { ...identity, type: "turn_started", sequence: 0, timestamp: "2026-09-09T00:00:00Z" });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_queued", sequence: 1, timestamp: "2026-09-09T00:00:01Z", callId: "call-1", name: "lookup", display: { title: "Look up", subject: "record-1" } });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_started", sequence: 2, timestamp: "2026-09-09T00:00:02Z", callId: "call-1", name: "lookup" });
    state = reduceTurnStreamEvent(state, { ...identity, type: "usage", sequence: 3, timestamp: "2026-09-09T00:00:03Z", inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    state = reduceTurnStreamEvent(state, { ...identity, type: "usage", sequence: 4, timestamp: "2026-09-09T00:00:04Z", inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    const response = projectTurnStream(state, "response-1");
    expect(response).toMatchObject({ metrics: { startedAt: "2026-09-09T00:00:00Z", usage: { inputTokens: 12, outputTokens: 23, totalTokens: 35 }, toolCount: 1 }, blocks: [{ type: "agent_execution", steps: [{ display: { title: "Look up", subject: "record-1" }, startedAt: "2026-09-09T00:00:02Z" }] }] });
  });
});
