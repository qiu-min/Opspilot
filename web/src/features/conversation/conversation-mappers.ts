import type { ConversationSummaryResponse } from "../../api/conversations/conversation-contracts";
import type { ConversationSummary } from "./types";

export function toConversationSummary(response: ConversationSummaryResponse): ConversationSummary {
  return {
    id: response.id,
    title: response.title,
    updatedAt: response.updatedAtUtc,
  };
}
