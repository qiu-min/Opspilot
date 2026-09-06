import type {
  ConversationStreamActivity,
  ConversationStreamPhase,
  ConversationStreamState,
  ConversationStreamToolExecution,
} from "./conversation-stream-state";
import type {
  AssistantTextBlock,
  ConversationResponseBlock,
  ConversationResponseBlockStatus,
  ConversationResponseItem,
  ConversationResponseStatus,
  ToolExecutionBlock,
} from "./types";

export type ToolPresentation = {
  title: string;
};

const TOOL_PRESENTATIONS: Record<string, ToolPresentation> = {
  get_workbook_info: { title: "Get workbook info" },
  get_sheet_profile: { title: "Get sheet profile" },
  inspect_worksheets: { title: "Inspect worksheets" },
  read_workbook: { title: "Read workbook" },
  write_workbook: { title: "Write workbook" },
};

/** Converts an internal tool identifier into readable fallback UI text. */
export function humanizeToolName(toolName: string): string {
  const humanized = toolName
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (!humanized) return "Tool execution";

  return humanized.replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Returns the frontend-only label for an Agent Service tool name. */
export function getToolPresentation(toolName: string): ToolPresentation {
  return TOOL_PRESENTATIONS[toolName.trim().toLowerCase()] ?? {
    title: humanizeToolName(toolName),
  };
}

/** Projects one response stream into one ordered response container. */
export function projectConversationStream(
  state: ConversationStreamState,
  responseId: string,
): ConversationResponseItem | undefined {
  if (state.phase === "idle") return undefined;

  const blocks = state.activity.flatMap<ConversationResponseBlock>((activity) => {
    if (activity.type === "assistant-message") {
      return projectAssistantBlock(state, activity, responseId);
    }

    const tool = findToolExecution(state, activity.callId);
    return tool === undefined ? [] : [projectToolBlock(tool, state.phase)];
  });

  return {
    type: "response",
    id: responseId,
    status: projectResponseStatus(state),
    blocks,
  };
}

function projectAssistantBlock(
  state: ConversationStreamState,
  activity: Extract<ConversationStreamActivity, { type: "assistant-message" }>,
  responseId: string,
): AssistantTextBlock[] {
  const message = state.assistantMessages[activity.messageIndex];
  if (message === undefined) return [];

  return [
    {
      type: "assistant_text",
      id: `${responseId}-assistant-${activity.messageIndex}`,
      text: message.text,
      completed: message.completed,
      createdAt: "Now",
    },
  ];
}

function projectToolBlock(
  tool: ConversationStreamToolExecution,
  streamPhase: ConversationStreamPhase,
): ToolExecutionBlock {
  return {
    type: "tool_execution",
    id: tool.callId,
    callId: tool.callId,
    name: tool.name,
    status: projectToolStatus(tool, streamPhase),
    createdAt: "Now",
  };
}

function findToolExecution(
  state: ConversationStreamState,
  callId: string,
): ConversationStreamToolExecution | undefined {
  return state.toolExecutions.find((tool) => tool.callId === callId);
}

function projectToolStatus(
  tool: ConversationStreamToolExecution,
  streamPhase: ConversationStreamPhase,
): ConversationResponseBlockStatus {
  if (tool.status === "completed") {
    return tool.isError ? "failed" : "completed";
  }

  return streamPhase === "streaming" ? "running" : "interrupted";
}

function projectResponseStatus(state: ConversationStreamState): ConversationResponseStatus {
  if (state.phase === "streaming") return "streaming";
  if (state.phase === "error") return "failed";
  if (state.completion?.status === "aborted") return "aborted";
  if (state.completion?.status === "completed") return "completed";
  return "failed";
}
