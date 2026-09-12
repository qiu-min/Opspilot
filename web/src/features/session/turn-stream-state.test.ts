import { describe, expect, it } from "vitest";
import { hydrateTurnStreamStateFromProjection, reduceTurnStreamEvent } from "./turn-stream-state";

const identity = { turnId: "t", sessionId: "s" };
describe("TurnStreamState", () => {
  it("hydrates partial assistant text and tools from projection", () => {
    const state = hydrateTurnStreamStateFromProjection({ ...identity, status: "running", startedAt: "2026-09-09T00:00:00Z", assistant: { text: "partial", messageVisible: true, isThinking: false }, tools: [{ callId: "call-1", name: "lookup", status: "running", display: { title: "Look up", subject: "record-1" }, startedAt: "2026-09-09T00:00:01Z", completedAt: "2026-09-09T00:00:02Z" }], compaction: { status: "idle" }, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, lastSequence: 7 });
    expect(state.lastSequence).toBe(7); expect(state.startedAt).toBe("2026-09-09T00:00:00Z"); expect(state.assistantMessages[0].text).toBe("partial"); expect(state.toolExecutions[0]).toMatchObject({ callId: "call-1", display: { title: "Look up", subject: "record-1" }, startedAt: "2026-09-09T00:00:01Z", completedAt: "2026-09-09T00:00:02Z" }); expect(state.usageEvents).toEqual([{ inputTokens: 10, outputTokens: 20, totalTokens: 30 }]);
  });
  it("reduces live events by Turn identity and sequence", () => {
    let state = hydrateTurnStreamStateFromProjection({ ...identity, status: "running", assistant: { text: "", messageVisible: false, isThinking: false }, tools: [], compaction: { status: "idle" }, usage: null, lastSequence: -1 });
    state = reduceTurnStreamEvent(state, { ...identity, type: "assistant_message_started", sequence: 0, timestamp: "2026-09-09T00:00:00Z" });
    state = reduceTurnStreamEvent(state, { ...identity, type: "assistant_text_delta", delta: "hello", sequence: 1, timestamp: "2026-09-09T00:00:01Z" });
    expect(state.assistantMessages[0].text).toBe("hello"); expect(state.lastSequence).toBe(1);
  });

  it("preserves tool display metadata when a later lifecycle event omits it", () => {
    let state = hydrateTurnStreamStateFromProjection({ ...identity, status: "running", assistant: { text: "", messageVisible: false, isThinking: false }, tools: [], compaction: { status: "idle" }, usage: null, lastSequence: -1 });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_queued", sequence: 0, timestamp: "2026-09-09T00:00:00Z", callId: "call-1", name: "get_sheet_profile", display: { title: "Inspect Worksheet", subject: "Sheet1" } });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_started", sequence: 1, timestamp: "2026-09-09T00:00:01Z", callId: "call-1", name: "get_sheet_profile" });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_completed", sequence: 2, timestamp: "2026-09-09T00:00:02Z", callId: "call-1", name: "get_sheet_profile", isError: false });
    expect(state.toolExecutions[0]).toMatchObject({ status: "completed", display: { title: "Inspect Worksheet", subject: "Sheet1" }, startedAt: "2026-09-09T00:00:01Z", completedAt: "2026-09-09T00:00:02Z" });
  });

  it("lets a later display replace the old one while keeping first timestamps", () => {
    let state = hydrateTurnStreamStateFromProjection({ ...identity, status: "running", assistant: { text: "", messageVisible: false, isThinking: false }, tools: [], compaction: { status: "idle" }, usage: null, lastSequence: -1 });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_queued", sequence: 0, timestamp: "2026-09-09T00:00:00Z", callId: "call-1", name: "lookup", display: { title: "Queued" } });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_started", sequence: 1, timestamp: "2026-09-09T00:00:01Z", callId: "call-1", name: "lookup", display: { title: "Running" } });
    state = reduceTurnStreamEvent(state, { ...identity, type: "tool_started", sequence: 2, timestamp: "2026-09-09T00:00:02Z", callId: "call-1", name: "lookup", display: { title: "Replayed" } });
    expect(state.toolExecutions[0]).toMatchObject({ display: { title: "Replayed" }, startedAt: "2026-09-09T00:00:01Z" });
  });

  it("records the first turn timestamp and terminal timestamp", () => {
    let state = hydrateTurnStreamStateFromProjection({ ...identity, status: "running", assistant: { text: "", messageVisible: false, isThinking: false }, tools: [], compaction: { status: "idle" }, usage: null, lastSequence: -1 });
    state = reduceTurnStreamEvent(state, { ...identity, type: "turn_started", sequence: 0, timestamp: "2026-09-09T00:00:00Z" });
    state = reduceTurnStreamEvent(state, { ...identity, type: "turn_completed", sequence: 1, timestamp: "2026-09-09T00:00:02Z", resultLeafId: "leaf-1" });
    state = reduceTurnStreamEvent(state, { ...identity, type: "turn_completed", sequence: 2, timestamp: "2026-09-09T00:00:03Z", resultLeafId: "leaf-1" });
    expect(state.startedAt).toBe("2026-09-09T00:00:00Z");
    expect(state.completedAt).toBe("2026-09-09T00:00:02Z");
  });
});
