import type { ConversationStreamEvent } from "../../api/conversations/conversation-stream-contracts";

export type ConversationStreamPhase = "idle" | "streaming" | "completed" | "error";

export type ConversationStreamAssistantMessage = {
  text: string;
  completed: boolean;
};

export type ConversationStreamActivity =
  | {
      type: "assistant-message";
      messageIndex: number;
    }
  | {
      type: "agent-execution";
      batchId: string;
    };

export type ConversationStreamToolExecution = {
  batchId: string;
  callId: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed";
};

export type ConversationStreamUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ConversationStreamCompaction = {
  status: "idle" | "running" | "completed";
  reason: string | null;
  aborted: boolean;
  failed: boolean;
  willRetry: boolean;
};

export type ConversationStreamCompletion = {
  conversationId: string;
  leafId: string | null;
  status: string;
};

export type ConversationStreamState = {
  phase: ConversationStreamPhase;
  isThinking: boolean;
  assistantMessages: ConversationStreamAssistantMessage[];
  activity: ConversationStreamActivity[];
  toolExecutions: ConversationStreamToolExecution[];
  usageEvents: ConversationStreamUsage[];
  compaction: ConversationStreamCompaction;
  completion: ConversationStreamCompletion | null;
  error: string | null;
};

export class ConversationStreamStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationStreamStateError";
  }
}

export function createInitialConversationStreamState(): ConversationStreamState {
  return {
    phase: "idle",
    isThinking: false,
    assistantMessages: [],
    activity: [],
    toolExecutions: [],
    usageEvents: [],
    compaction: {
      status: "idle",
      reason: null,
      aborted: false,
      failed: false,
      willRetry: false,
    },
    completion: null,
    error: null,
  };
}

export function reduceConversationStreamEvent(
  state: ConversationStreamState,
  event: ConversationStreamEvent,
): ConversationStreamState {
  switch (event.type) {
    case "response_started":
      if (state.phase !== "idle") {
        throw stateError("response_started is only valid while the stream is idle");
      }

      return { ...state, phase: "streaming", error: null, completion: null };

    case "assistant_thinking_started":
      ensureStreaming(state, event.type);
      if (state.isThinking) {
        throw stateError("assistant_thinking_started is invalid while already thinking");
      }

      return { ...state, isThinking: true };

    case "assistant_thinking_completed":
      ensureStreaming(state, event.type);
      if (!state.isThinking) {
        throw stateError("assistant_thinking_completed requires active thinking");
      }

      return { ...state, isThinking: false };

    case "assistant_message_started":
      ensureStreaming(state, event.type);
      if (state.isThinking || hasActiveAssistantMessage(state)) {
        throw stateError("assistant_message_started requires no active assistant message or thinking");
      }

      return {
        ...state,
        assistantMessages: [
          ...state.assistantMessages,
          { text: "", completed: false },
        ],
        activity: [
          ...state.activity,
          {
            type: "assistant-message",
            messageIndex: state.assistantMessages.length,
          },
        ],
      };

    case "assistant_text_delta": {
      ensureStreaming(state, event.type);
      if (state.isThinking) {
        throw stateError("assistant_text_delta is invalid while thinking is active");
      }

      const activeMessageIndex = findActiveAssistantMessageIndex(state);
      const assistantMessages = [...state.assistantMessages];
      const activeMessage = assistantMessages[activeMessageIndex];
      assistantMessages[activeMessageIndex] = {
        ...activeMessage,
        text: activeMessage.text + event.delta,
      };

      return { ...state, assistantMessages };
    }

    case "assistant_message_completed": {
      ensureStreaming(state, event.type);
      if (state.isThinking) {
        throw stateError("assistant_message_completed is invalid while thinking is active");
      }

      const activeMessageIndex = findActiveAssistantMessageIndex(state);
      const assistantMessages = [...state.assistantMessages];
      assistantMessages[activeMessageIndex] = {
        ...assistantMessages[activeMessageIndex],
        completed: true,
      };

      return { ...state, assistantMessages };
    }

    case "tool_execution_queued":
      ensureStreaming(state, event.type);
      if (state.toolExecutions.some((tool) => tool.callId === event.callId)) {
        throw stateError(`tool_execution_queued duplicated callId ${event.callId}`);
      }

      return {
        ...state,
        toolExecutions: [
          ...state.toolExecutions,
          {
            batchId: event.batchId,
            callId: event.callId,
            name: event.name,
            status: "queued",
          },
        ],
        activity: state.activity.some(
          (activity) =>
            activity.type === "agent-execution" && activity.batchId === event.batchId,
        )
          ? state.activity
          : [...state.activity, { type: "agent-execution", batchId: event.batchId }],
      };

    case "tool_execution_started":
      ensureStreaming(state, event.type);
      {
        const toolIndex = state.toolExecutions.findIndex(
          (tool) => tool.callId === event.callId,
        );

        if (toolIndex === -1) {
          const batchId = `tool-batch-${event.callId}`;
          return {
            ...state,
            toolExecutions: [
              ...state.toolExecutions,
              {
                batchId,
                callId: event.callId,
                name: event.name,
                status: "running",
              },
            ],
            activity: state.activity.some(
              (activity) =>
                activity.type === "agent-execution" && activity.batchId === batchId,
            )
              ? state.activity
              : [...state.activity, { type: "agent-execution", batchId }],
          };
        }

        const queuedTool = state.toolExecutions[toolIndex];
        if (queuedTool.status !== "queued") {
          throw stateError(`tool_execution_started duplicated callId ${event.callId}`);
        }
        if (queuedTool.name !== event.name) {
          throw stateError(`tool_execution_started name mismatch for callId ${event.callId}`);
        }

        const toolExecutions = [...state.toolExecutions];
        toolExecutions[toolIndex] = {
          ...queuedTool,
          status: "running",
        };
        return { ...state, toolExecutions };
      }

    case "tool_execution_completed": {
      ensureStreaming(state, event.type);
      const toolIndex = state.toolExecutions.findIndex(
        (tool) => tool.callId === event.callId,
      );
      if (toolIndex === -1) {
        throw stateError(`tool_execution_completed has no running callId ${event.callId}`);
      }

      const runningTool = state.toolExecutions[toolIndex];
      if (runningTool.status !== "running") {
        throw stateError(`tool_execution_completed has no running callId ${event.callId}`);
      }
      if (runningTool.name !== event.name) {
        throw stateError(`tool_execution_completed name mismatch for callId ${event.callId}`);
      }

      const toolExecutions = [...state.toolExecutions];
      toolExecutions[toolIndex] = {
        callId: runningTool.callId,
        batchId: runningTool.batchId,
        name: runningTool.name,
        status: event.isError ? "failed" : "completed",
      };

      return { ...state, toolExecutions };
    }

    case "usage":
      ensureStreaming(state, event.type);
      return {
        ...state,
        usageEvents: [
          ...state.usageEvents,
          {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.totalTokens,
          },
        ],
      };

    case "context_compaction_started":
      ensureStreaming(state, event.type);
      if (state.compaction.status === "running") {
        throw stateError("context_compaction_started is invalid while compaction is running");
      }

      return {
        ...state,
        compaction: {
          status: "running",
          reason: event.reason,
          aborted: false,
          failed: false,
          willRetry: false,
        },
      };

    case "context_compaction_completed":
      ensureStreaming(state, event.type);
      if (state.compaction.status !== "running") {
        throw stateError("context_compaction_completed requires active compaction");
      }

      return {
        ...state,
        compaction: {
          status: "completed",
          reason: event.reason,
          aborted: event.aborted,
          failed: event.failed,
          willRetry: event.willRetry,
        },
      };

    case "response_completed":
      ensureStreaming(state, event.type);
      return {
        ...state,
        phase: "completed",
        isThinking: false,
        completion: {
          conversationId: event.conversationId,
          leafId: event.leafId,
          status: event.status,
        },
        error: null,
      };

    case "error":
      ensureStreaming(state, event.type);
      return {
        ...state,
        phase: "error",
        isThinking: false,
        completion: null,
        error: event.message,
      };

    default:
      return assertNever(event);
  }
}

function ensureStreaming(
  state: ConversationStreamState,
  eventType: ConversationStreamEvent["type"],
): void {
  if (state.phase !== "streaming") {
    throw stateError(`${eventType} is only valid while the stream is active`);
  }
}

function hasActiveAssistantMessage(state: ConversationStreamState): boolean {
  return state.assistantMessages.some((message) => !message.completed);
}

function findActiveAssistantMessageIndex(state: ConversationStreamState): number {
  for (let index = state.assistantMessages.length - 1; index >= 0; index -= 1) {
    if (!state.assistantMessages[index].completed) {
      return index;
    }
  }

  throw stateError("assistant event requires an active assistant message");
}

function stateError(message: string): ConversationStreamStateError {
  return new ConversationStreamStateError(message);
}

function assertNever(value: never): never {
  throw stateError(`Unsupported conversation stream event: ${String(value)}`);
}
