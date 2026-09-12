import { describe, expect, it } from "vitest";
import { mergeLiveTurnResponse, toSessionItems } from "./session-mappers";

describe("Session history mapper", () => {
  it("keeps durable history and projects tool execution by callId", () => {
    const items = toSessionItems({ id: "s", title: "New session", createdAtUtc: "2026-09-09T00:00:00Z", updatedAtUtc: "2026-09-09T00:00:00Z", items: [
      { type: "message", id: "u", role: "user", text: "inspect", createdAtUtc: "2026-09-09T00:00:00Z" },
      { type: "tool_execution", id: "t", callId: "call-1", name: "lookup", status: "completed", createdAtUtc: "2026-09-09T00:00:01Z" },
      { type: "message", id: "a", role: "assistant", text: "done", createdAtUtc: "2026-09-09T00:00:02Z" },
    ] });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: "response", blocks: [{ type: "agent_execution", steps: [{ callId: "call-1" }] }, { type: "assistant_text", text: "done" }] });
  });

  it("does not duplicate a tool already present in durable history", () => {
    const durable = [{
      type: "response" as const,
      id: "turn-response",
      status: "completed" as const,
      blocks: [{ type: "agent_execution" as const, id: "execution-call-1", batchId: "batch-1", steps: [{ id: "call-1", callId: "call-1", name: "lookup", status: "completed" as const }] }],
    }];
    const live = {
      type: "response" as const,
      id: "live-turn",
      status: "streaming" as const,
      blocks: [{ type: "agent_execution" as const, id: "execution-live", batchId: "batch-live", steps: [
        { id: "call-1", callId: "call-1", name: "lookup", status: "completed" as const },
        { id: "call-2", callId: "call-2", name: "read_workbook", status: "running" as const },
      ] }],
    };
    const merged = mergeLiveTurnResponse(durable, live, "live-turn");
    expect(merged[0]).toMatchObject({ blocks: [
      { type: "agent_execution", steps: [{ callId: "call-1" }] },
      { type: "agent_execution", steps: [{ callId: "call-2" }] },
    ] });
  });

  it("keeps live metrics while merging shared tool rows into durable history", () => {
    const durable = [{ type: "response" as const, id: "turn-response", status: "completed" as const, blocks: [{ type: "agent_execution" as const, id: "execution-call-1", batchId: "batch-1", steps: [{ id: "call-1", callId: "call-1", name: "lookup", status: "completed" as const }] }] }];
    const live = { type: "response" as const, id: "live-turn", status: "completed" as const, metrics: { startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:03Z", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, toolCount: 1 }, blocks: [{ type: "agent_execution" as const, id: "execution-live", batchId: "batch-live", steps: [{ id: "call-1", callId: "call-1", name: "lookup", status: "completed" as const, startedAt: "2026-09-09T00:00:01Z", completedAt: "2026-09-09T00:00:02Z" }] }] };
    const merged = mergeLiveTurnResponse(durable, live, "live-turn");
    expect(merged[0]).toMatchObject({ metrics: live.metrics, blocks: [{ type: "agent_execution", steps: [{ callId: "call-1", startedAt: "2026-09-09T00:00:01Z" }] }] });
  });

  it("reconciles a completed assistant response with the latest durable response", () => {
    const durable = [{ type: "message" as const, id: "user-1", message: { id: "user-1", role: "user" as const, body: "inspect", createdAt: "Recently" } }, { type: "response" as const, id: "response-user-1", status: "completed" as const, blocks: [{ type: "assistant_text" as const, id: "assistant-1", text: "done", completed: true }] }];
    const live = { type: "response" as const, id: "live-turn", status: "completed" as const, metrics: { startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:01Z", usage: null, toolCount: 0 }, blocks: [{ type: "assistant_text" as const, id: "live-assistant", text: "done", completed: true }] };
    const merged = mergeLiveTurnResponse(durable, live, "live-turn");
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ id: "live-turn", metrics: live.metrics, blocks: [{ type: "assistant_text", text: "done" }] });
  });
});
