import { describe, expect, it } from "vitest";
import type { ConversationStreamEvent } from "../../api/conversations/conversation-stream-contracts";
import {
  createInitialConversationStreamState,
  reduceConversationStreamEvent,
} from "./conversation-stream-state";
import {
  getToolPresentation,
  projectConversationStream,
} from "./conversation-stream-projection";

function reduceEvents(events: ConversationStreamEvent[]) {
  return events.reduce(reduceConversationStreamEvent, createInitialConversationStreamState());
}

function startTool(callId: string, name: string): ConversationStreamEvent {
  return { type: "tool_execution_started", callId, name };
}

function completeTool(
  callId: string,
  name: string,
  isError = false,
): ConversationStreamEvent {
  return { type: "tool_execution_completed", callId, name, isError };
}

function assistant(text: string): ConversationStreamEvent[] {
  return [
    { type: "assistant_message_started" },
    { type: "assistant_text_delta", delta: text },
    { type: "assistant_message_completed" },
  ];
}

describe("conversation stream response projection", () => {
  it("projects a simple response into one assistant block", () => {
    const state = reduceEvents([
      { type: "response_started" },
      ...assistant("hello"),
      { type: "response_completed", conversationId: "conversation-1", leafId: null, status: "completed" },
    ]);

    const response = projectConversationStream(state, "response-1");

    expect(response).toMatchObject({
      type: "response",
      id: "response-1",
      status: "completed",
      blocks: [
        expect.objectContaining({ type: "assistant_text", text: "hello", completed: true }),
      ],
    });
  });

  it("keeps assistant and tool blocks in exact activity order", () => {
    const state = reduceEvents([
      { type: "response_started" },
      ...assistant("assistant A"),
      startTool("call-a", "get_workbook_info"),
      completeTool("call-a", "get_workbook_info"),
      ...assistant("assistant B"),
      startTool("call-b", "get_sheet_profile"),
      completeTool("call-b", "get_sheet_profile"),
      startTool("call-c", "get_sheet_profile"),
      completeTool("call-c", "get_sheet_profile"),
      ...assistant("assistant C"),
    ]);

    const response = projectConversationStream(state, "response-1");

    expect(response?.blocks.map((block) => block.type)).toEqual([
      "assistant_text",
      "tool_execution",
      "assistant_text",
      "tool_execution",
      "tool_execution",
      "assistant_text",
    ]);
    expect(response?.blocks.map((block) => block.id)).toEqual([
      "response-1-assistant-0",
      "call-a",
      "response-1-assistant-1",
      "call-b",
      "call-c",
      "response-1-assistant-2",
    ]);
  });

  it("shows a running tool immediately and updates the same callId block in place", () => {
    const runningState = reduceEvents([
      { type: "response_started" },
      startTool("call-a", "get_workbook_info"),
    ]);
    const completedState = reduceEvents([
      { type: "response_started" },
      startTool("call-a", "get_workbook_info"),
      completeTool("call-a", "get_workbook_info"),
    ]);

    const running = projectConversationStream(runningState, "response-1");
    const completed = projectConversationStream(completedState, "response-1");
    const runningBlock = running?.blocks[0];
    const completedBlock = completed?.blocks[0];

    expect(runningBlock).toMatchObject({ id: "call-a", callId: "call-a", status: "running" });
    expect(completedBlock).toMatchObject({ id: "call-a", callId: "call-a", status: "completed" });
  });

  it("preserves failed tool position and status", () => {
    const state = reduceEvents([
      { type: "response_started" },
      ...assistant("before"),
      startTool("call-a", "get_sheet_profile"),
      completeTool("call-a", "get_sheet_profile", true),
      ...assistant("after"),
    ]);

    const response = projectConversationStream(state, "response-1");

    expect(response?.blocks[1]).toMatchObject({
      type: "tool_execution",
      id: "call-a",
      status: "failed",
    });
    expect(response?.blocks.map((block) => block.type)).toEqual([
      "assistant_text",
      "tool_execution",
      "assistant_text",
    ]);
  });

  it("keeps produced blocks and marks a running tool interrupted after stream error", () => {
    const state = reduceEvents([
      { type: "response_started" },
      ...assistant("before"),
      startTool("call-a", "get_workbook_info"),
      { type: "error", message: "stream interrupted" },
    ]);

    const response = projectConversationStream(state, "response-1");

    expect(response?.status).toBe("failed");
    expect(response?.blocks).toEqual([
      expect.objectContaining({ type: "assistant_text", text: "before" }),
      expect.objectContaining({ type: "tool_execution", id: "call-a", status: "interrupted" }),
    ]);
  });

  it("maps an aborted completion to an aborted response without dropping tools", () => {
    const state = reduceEvents([
      { type: "response_started" },
      startTool("call-a", "get_workbook_info"),
      { type: "response_completed", conversationId: "conversation-1", leafId: null, status: "aborted" },
    ]);

    const response = projectConversationStream(state, "response-1");

    expect(response?.status).toBe("aborted");
    expect(response?.blocks[0]).toMatchObject({ id: "call-a", status: "interrupted" });
  });

  it("uses centralized tool presentation mapping with a humanized fallback", () => {
    expect(getToolPresentation("get_workbook_info").title).toBe("Get workbook info");
    expect(getToolPresentation("unknown_tool-name").title).toBe("Unknown Tool Name");
  });
});
