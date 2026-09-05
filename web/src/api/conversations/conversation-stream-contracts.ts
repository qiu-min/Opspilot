export type ConversationStreamEvent =
  | { type: "response_started" }
  | { type: "assistant_thinking_started" }
  | { type: "assistant_thinking_completed" }
  | { type: "assistant_message_started" }
  | { type: "assistant_text_delta"; delta: string }
  | { type: "assistant_message_completed" }
  | { type: "tool_execution_started"; callId: string; name: string }
  | {
      type: "tool_execution_completed";
      callId: string;
      name: string;
      isError: boolean;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    }
  | { type: "context_compaction_started"; reason: string }
  | {
      type: "context_compaction_completed";
      reason: string;
      aborted: boolean;
      failed: boolean;
      willRetry: boolean;
    }
  | {
      type: "response_completed";
      conversationId: string;
      leafId: string | null;
      status: string;
    }
  | { type: "error"; message: string };

export class ConversationStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationStreamProtocolError";
  }
}
