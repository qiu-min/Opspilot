import { describe, expect, it } from "vitest";
import { mergeLiveTurnResponse, toSessionItems } from "./session-mappers";

describe("Session history mapper", () => {
  it("merges a normal assistant Turn only when durable identity matches", () => {
    const before = [{ type: "response" as const, id: "response-a", status: "completed" as const, blocks: [{ type: "assistant_text" as const, id: "assistant-a", text: "Response A", completed: true }] }];
    const after = [...before, { type: "response" as const, id: "turn-b", status: "completed" as const, blocks: [{ type: "assistant_text" as const, id: "assistant-b", text: "hello", completed: true }] }];
    const live = { type: "response" as const, id: "turn-b", status: "completed" as const, metrics: { startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:01Z", usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 }, toolCount: 0 }, blocks: [{ type: "assistant_text" as const, id: "live-assistant", text: "hello", completed: true }] };

    const merged = mergeLiveTurnResponse(after, live, live.id);

    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ metrics: live.metrics, blocks: [{ type: "assistant_text", text: "hello" }] });
    expect(merged[1]?.type === "response" ? merged[1].blocks.filter((block) => block.type === "assistant_text") : []).toHaveLength(1);
  });

  it("keeps durable history and projects tool execution by callId", () => {
    const items = toSessionItems({ id: "s", title: "New session", createdAtUtc: "2026-09-09T00:00:00Z", updatedAtUtc: "2026-09-09T00:00:00Z", items: [
      { type: "message", id: "u", role: "user", text: "inspect", createdAtUtc: "2026-09-09T00:00:00Z" },
      { type: "tool_execution", id: "t", callId: "call-1", name: "lookup", status: "completed", createdAtUtc: "2026-09-09T00:00:01Z" },
      { type: "message", id: "a", role: "assistant", text: "done", createdAtUtc: "2026-09-09T00:00:02Z" },
    ], turnSummaries: [] });
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ type: "response", blocks: [{ type: "agent_execution", steps: [{ callId: "call-1" }] }, { type: "assistant_text", text: "done" }] });
  });

  it("restores durable Turn identity, metrics, status, and tool presentation by inputEntryId", () => {
    const items = toSessionItems({
      id: "s",
      title: "New session",
      createdAtUtc: "2026-09-09T00:00:00Z",
      updatedAtUtc: "2026-09-09T00:00:00Z",
      items: [
        { type: "message", id: "user-1", role: "user", text: "inspect", createdAtUtc: "2026-09-09T00:00:00Z" },
        { type: "tool_execution", id: "tool-1", callId: "call-1", name: "get_sheet_profile", status: "completed", createdAtUtc: "2026-09-09T00:00:01Z" },
        { type: "message", id: "assistant-1", role: "assistant", text: "done", createdAtUtc: "2026-09-09T00:00:02Z" },
      ],
      turnSummaries: [{
        turnId: "turn-1",
        sessionId: "s",
        inputEntryId: "user-1",
        status: "completed",
        startedAt: "2026-09-09T00:00:00Z",
        completedAt: "2026-09-09T00:00:05Z",
        usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 },
        tools: [{
          callId: "call-1",
          name: "get_sheet_profile",
          status: "completed",
          display: { title: "Inspect Worksheet", subject: "Sheet1" },
          startedAt: "2026-09-09T00:00:01Z",
          completedAt: "2026-09-09T00:00:02Z",
        }],
      }],
    });

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      type: "response",
      id: "turn-turn-1",
      turnId: "turn-1",
      status: "completed",
      metrics: { startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:05Z", usage: { inputTokens: 100, outputTokens: 40, totalTokens: 140 }, toolCount: 1 },
      blocks: [
        { type: "agent_execution", steps: [{ callId: "call-1", display: { title: "Inspect Worksheet", subject: "Sheet1" }, startedAt: "2026-09-09T00:00:01Z", completedAt: "2026-09-09T00:00:02Z" }] },
        { type: "assistant_text", text: "done" },
      ],
    });
  });

  it("keeps consecutive Turn summaries associated with their own user messages", () => {
    const items = toSessionItems({
      id: "s",
      title: "New session",
      createdAtUtc: "2026-09-09T00:00:00Z",
      updatedAtUtc: "2026-09-09T00:00:00Z",
      items: [
        { type: "message", id: "user-a", role: "user", text: "first", createdAtUtc: "2026-09-09T00:00:00Z" },
        { type: "message", id: "assistant-a", role: "assistant", text: "one", createdAtUtc: "2026-09-09T00:00:01Z" },
        { type: "message", id: "user-b", role: "user", text: "second", createdAtUtc: "2026-09-09T00:00:02Z" },
        { type: "message", id: "assistant-b", role: "assistant", text: "two", createdAtUtc: "2026-09-09T00:00:03Z" },
      ],
      turnSummaries: [
        { turnId: "turn-b", sessionId: "s", inputEntryId: "user-b", status: "cancelled", startedAt: "2026-09-09T00:00:02Z", completedAt: "2026-09-09T00:00:04Z", usage: null, tools: [] },
        { turnId: "turn-a", sessionId: "s", inputEntryId: "user-a", status: "failed", startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:01Z", usage: null, tools: [] },
      ],
    });

    expect(items.filter((item) => item.type === "response")).toMatchObject([
      { id: "turn-turn-a", status: "failed", metrics: { toolCount: 0 } },
      { id: "turn-turn-b", status: "aborted", metrics: { toolCount: 0 } },
    ]);
  });

  it("retains a terminal failed response even when it has no blocks", () => {
    const items = toSessionItems({
      id: "s",
      title: "New session",
      createdAtUtc: "2026-09-09T00:00:00Z",
      updatedAtUtc: "2026-09-09T00:00:00Z",
      items: [{ type: "message", id: "user-1", role: "user", text: "fail", createdAtUtc: "2026-09-09T00:00:00Z" }],
      turnSummaries: [{ turnId: "turn-failed", sessionId: "s", inputEntryId: "user-1", status: "failed", startedAt: "2026-09-09T00:00:00Z", completedAt: "2026-09-09T00:00:01Z", usage: null, tools: [] }],
    });

    expect(items).toEqual([
      expect.objectContaining({ type: "message", id: "user-1" }),
      expect.objectContaining({ type: "response", id: "turn-turn-failed", status: "failed", blocks: [] }),
    ]);
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
