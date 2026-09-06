import { describe, expect, it } from "vitest";
import type { ConversationDetailResponse } from "../../api/conversations/conversation-contracts";
import {
  reconcileConversationItems,
  toConversationItems,
} from "./conversation-mappers";
import type { ConversationItem, ConversationResponseItem } from "./types";

function history(items: ConversationDetailResponse["items"]): ConversationDetailResponse {
  return {
    id: "conversation-1",
    title: "Conversation",
    createdAtUtc: "2026-09-06T00:00:00Z",
    updatedAtUtc: "2026-09-06T00:00:00Z",
    items,
  };
}

describe("conversation history mapping", () => {
  it("groups all messages and tools after one user into one completed response", () => {
    const items = toConversationItems(history([
      { type: "message", id: "user-1", role: "user", text: "question", createdAtUtc: "2026-09-06T00:00:00Z" },
      { type: "message", id: "assistant-1", role: "assistant", text: "before", createdAtUtc: "2026-09-06T00:00:01Z" },
      { type: "tool_execution", id: "entry-tool-1", callId: "call-1", name: "get_workbook_info", status: "completed", createdAtUtc: "2026-09-06T00:00:02Z" },
      { type: "message", id: "assistant-2", role: "assistant", text: "after", createdAtUtc: "2026-09-06T00:00:03Z" },
      { type: "tool_execution", id: "entry-tool-2", callId: "call-2", name: "get_sheet_profile", status: "failed", createdAtUtc: "2026-09-06T00:00:04Z" },
    ]));

    expect(items.map((item) => item.type)).toEqual(["message", "response"]);
    const response = items[1];
    expect(response.type).toBe("response");
    if (response.type !== "response") return;
    expect(response.id).toBe("response-user-1");
    expect(response.blocks.map((block) => block.type)).toEqual([
      "assistant_text",
      "agent_execution",
      "assistant_text",
      "agent_execution",
    ]);
    expect(response.blocks[1]).toMatchObject({
      id: "execution-call-1",
      batchId: "tool-batch-call-1",
      steps: [{ id: "call-1", status: "completed" }],
    });
    expect(response.blocks[3]).toMatchObject({
      id: "execution-call-2",
      batchId: "tool-batch-call-2",
      steps: [{ id: "call-2", status: "failed" }],
    });
  });

  it("creates separate response containers for separate user turns", () => {
    const items = toConversationItems(history([
      { type: "message", id: "user-1", role: "user", text: "one", createdAtUtc: "2026-09-06T00:00:00Z" },
      { type: "message", id: "assistant-1", role: "assistant", text: "answer one", createdAtUtc: "2026-09-06T00:00:01Z" },
      { type: "message", id: "user-2", role: "user", text: "two", createdAtUtc: "2026-09-06T00:00:02Z" },
      { type: "message", id: "assistant-2", role: "assistant", text: "answer two", createdAtUtc: "2026-09-06T00:00:03Z" },
    ]));

    expect(items.map((item) => item.type)).toEqual([
      "message",
      "response",
      "message",
      "response",
    ]);
  });

  it("reconciles durable blocks without replacing the live response identity", () => {
    const durableItems = toConversationItems(history([
      { type: "message", id: "user-1", role: "user", text: "question", createdAtUtc: "2026-09-06T00:00:00Z" },
      { type: "message", id: "assistant-1", role: "assistant", text: "before", createdAtUtc: "2026-09-06T00:00:01Z" },
      { type: "tool_execution", id: "entry-tool-1", callId: "call-1", name: "get_workbook_info", status: "completed", createdAtUtc: "2026-09-06T00:00:02Z" },
      { type: "message", id: "assistant-2", role: "assistant", text: "after", createdAtUtc: "2026-09-06T00:00:03Z" },
    ]));
    const liveResponse: ConversationResponseItem = {
      type: "response",
      id: "response-temp",
      status: "completed",
      blocks: [
        { type: "assistant_text", id: "response-temp-assistant-0", text: "before", completed: true },
        {
          type: "agent_execution",
          id: "response-temp-execution-batch-a",
          batchId: "batch-a",
          steps: [{ id: "call-1", callId: "call-1", name: "get_workbook_info", status: "completed" }],
        },
        { type: "assistant_text", id: "response-temp-assistant-1", text: "after", completed: true },
      ],
    };
    const currentItems: ConversationItem[] = [
      { type: "message", id: "user-temp", message: { id: "user-temp", role: "user", body: "question", createdAt: "Now" } },
      liveResponse,
    ];

    const reconciled = reconcileConversationItems(currentItems, durableItems, "response-temp");
    const response = reconciled[1];

    expect(response.type).toBe("response");
    if (response.type !== "response") return;
    expect(response.id).toBe("response-temp");
    expect(response.blocks.map((block) => block.id)).toEqual([
      "response-temp-assistant-0",
      "response-temp-execution-batch-a",
      "response-temp-assistant-1",
    ]);
  });

  it("preserves a live aborted response status during durable reconciliation", () => {
    const durableItems = toConversationItems(history([
      { type: "message", id: "user-1", role: "user", text: "question", createdAtUtc: "2026-09-06T00:00:00Z" },
      { type: "message", id: "assistant-1", role: "assistant", text: "partial", createdAtUtc: "2026-09-06T00:00:01Z" },
    ]));
    const currentItems: ConversationItem[] = [
      { type: "message", id: "user-temp", message: { id: "user-temp", role: "user", body: "question", createdAt: "Now" } },
      {
        type: "response",
        id: "response-temp",
        status: "aborted",
        blocks: [{ type: "assistant_text", id: "response-temp-assistant-0", text: "partial", completed: false }],
      },
    ];

    const reconciled = reconcileConversationItems(currentItems, durableItems, "response-temp");
    const response = reconciled[1];

    expect(response.type).toBe("response");
    if (response.type !== "response") return;
    expect(response.status).toBe("aborted");
  });
});
