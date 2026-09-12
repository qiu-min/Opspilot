export type TurnStreamEventBase = { type: string; turnId: string; sessionId: string; sequence: number; timestamp: string };
export type ToolDisplayInfo = { title: string; subject?: string; detail?: string };
export type TurnStreamEvent =
  | (TurnStreamEventBase & { type: "turn_started" })
  | (TurnStreamEventBase & { type: "assistant_thinking_started" })
  | (TurnStreamEventBase & { type: "assistant_thinking_completed" })
  | (TurnStreamEventBase & { type: "assistant_message_started" })
  | (TurnStreamEventBase & { type: "assistant_text_delta"; delta: string })
  | (TurnStreamEventBase & { type: "assistant_message_completed" })
  | (TurnStreamEventBase & { type: "tool_queued"; callId: string; name: string; batchId?: string; display?: ToolDisplayInfo })
  | (TurnStreamEventBase & { type: "tool_started"; callId: string; name: string; display?: ToolDisplayInfo })
  | (TurnStreamEventBase & { type: "tool_completed"; callId: string; name: string; isError: boolean; display?: ToolDisplayInfo })
  | (TurnStreamEventBase & { type: "compaction_started"; reason?: string })
  | (TurnStreamEventBase & { type: "compaction_completed"; reason?: string; aborted?: boolean; failed?: boolean; willRetry?: boolean })
  | (TurnStreamEventBase & { type: "usage"; inputTokens: number; outputTokens: number; totalTokens: number })
  | (TurnStreamEventBase & { type: "turn_completed"; resultLeafId: string | null })
  | (TurnStreamEventBase & { type: "turn_failed"; message: string })
  | (TurnStreamEventBase & { type: "turn_cancelled" });

export class TurnStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TurnStreamProtocolError";
  }
}
