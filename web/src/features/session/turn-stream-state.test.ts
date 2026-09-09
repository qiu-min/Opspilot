import { describe, expect, it } from "vitest";
import { hydrateTurnStreamStateFromProjection, reduceTurnStreamEvent } from "./turn-stream-state";

const identity = { turnId: "t", sessionId: "s" };
describe("TurnStreamState", () => {
  it("hydrates partial assistant text and tools from projection", () => {
    const state = hydrateTurnStreamStateFromProjection({ ...identity, status: "running", assistant: { text: "partial", messageVisible: true, isThinking: false }, tools: [{ callId: "call-1", name: "lookup", status: "running" }], compaction: { status: "idle" }, usage: null, lastSequence: 7 });
    expect(state.lastSequence).toBe(7); expect(state.assistantMessages[0].text).toBe("partial"); expect(state.toolExecutions[0].callId).toBe("call-1");
  });
  it("reduces live events by Turn identity and sequence", () => {
    let state = hydrateTurnStreamStateFromProjection({ ...identity, status: "running", assistant: { text: "", messageVisible: false, isThinking: false }, tools: [], compaction: { status: "idle" }, usage: null, lastSequence: -1 });
    state = reduceTurnStreamEvent(state, { ...identity, type: "assistant_message_started", sequence: 0, timestamp: "2026-09-09T00:00:00Z" });
    state = reduceTurnStreamEvent(state, { ...identity, type: "assistant_text_delta", delta: "hello", sequence: 1, timestamp: "2026-09-09T00:00:01Z" });
    expect(state.assistantMessages[0].text).toBe("hello"); expect(state.lastSequence).toBe(1);
  });
});
