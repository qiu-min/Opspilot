import { describe, expect, it } from "vitest";
import { findNewDurableResponseId, mergeLiveTurnResponse, toSessionItems } from "./session-mappers";

describe("Session history mapper", () => {
  it("finds exactly one durable response added by a terminal refresh", () => {
    const previous = [{ type: "response" as const, id: "response-a", status: "completed" as const, blocks: [] }];
    const refreshed = [...previous, { type: "response" as const, id: "response-b", status: "completed" as const, blocks: [] }];
    expect(findNewDurableResponseId(previous, refreshed)).toBe("response-b");
    expect(findNewDurableResponseId(previous, previous)).toBeUndefined();
    expect(findNewDurableResponseId(previous, [...refreshed, { type: "response" as const, id: "response-c", status: "completed" as const, blocks: [] }])).toBeUndefined();
  });

  it("merges a normal assistant Turn into the unique new durable response", () => {
    const before = [{ type: "response" as const, id: "response-a", status: "completed" as const, blocks: [{ type: "assistant_text" as const, id: "assistant-a", text: "Response A", completed: true }] }];
    const after = [...before, { type: "response" as const, id: "response-server-b", status: "completed" as const, blocks: [{ type: "assistant_text" as const, id: "assistant-b", text: "hello", completed: true }] }];
    const live = { type: "response" as const, id: "turn-b", status: "completed" as const, metrics: { startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:01Z", usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, toolCount: 0 }, blocks: [{ type: "assistant_text" as const, id: "live-assistant", text: "hello", completed: true }] };

    const merged = mergeLiveTurnResponse(after, live, live.id, findNewDurableResponseId(before, after));

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ metrics: live.metrics, blocks: [{ type: "assistant_text", text: "hello" }] });
    expect(merged[1]?.type === "response" ? merged[1].blocks.filter((block) => block.type === "assistant_text") : []).toHaveLength(1);
  });

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
    const live = { type: "response" as const, id: "live-turn", status: "completed" as const, metrics: { startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:03Z", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }, toolCount: 1 }, blocks: [{ type: "agent_execution" as const, id: "execution-live", batchId: "batch-live", steps: [{ id: "call-1", callId: "call-1", name: "lookup", status: "completed" as const, display: { title: "Lookup record" }, startedAt: "2026-09-09T00:00:01Z", completedAt: "2026-09-09T00:00:02Z" }] }] };
    const merged = mergeLiveTurnResponse(durable, live, "live-turn");
    expect(merged[0]).toMatchObject({ metrics: live.metrics, blocks: [{ type: "agent_execution", steps: [{ callId: "call-1", display: { title: "Lookup record" }, startedAt: "2026-09-09T00:00:01Z" }] }] });
  });

  it("deduplicates a completed assistant response when response identity matches", () => {
    const durable = [{ type: "message" as const, id: "user-1", message: { id: "user-1", role: "user" as const, body: "inspect", createdAt: "Recently" } }, { type: "response" as const, id: "live-turn", status: "completed" as const, blocks: [{ type: "assistant_text" as const, id: "assistant-1", text: "done", completed: true }] }];
    const live = { type: "response" as const, id: "live-turn", status: "completed" as const, metrics: { startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:01Z", usage: null, toolCount: 0 }, blocks: [{ type: "assistant_text" as const, id: "live-assistant", text: "done", completed: true }] };
    const merged = mergeLiveTurnResponse(durable, live, "live-turn");
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ id: "live-turn", metrics: live.metrics, blocks: [{ type: "assistant_text", text: "done" }] });
  });

  it("keeps an unrelated durable response unchanged when terminal identity is unknown", () => {
    const durable = [
      { type: "message" as const, id: "user-a", message: { id: "user-a", role: "user" as const, body: "first", createdAt: "Recently" } },
      { type: "response" as const, id: "response-a", status: "completed" as const, blocks: [{ type: "assistant_text" as const, id: "assistant-a", text: "Response A", completed: true }] },
    ];
    const live = { type: "response" as const, id: "turn-b", status: "failed" as const, metrics: { startedAt: "2026-09-09T00:01:00Z", completedAt: "2026-09-09T00:01:01Z", usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, toolCount: 0 }, blocks: [] };

    const merged = mergeLiveTurnResponse(durable, live, "turn-b");

    expect(merged).toEqual([...durable, live]);
    expect(merged[1]).toEqual(durable[1]);
  });
});
