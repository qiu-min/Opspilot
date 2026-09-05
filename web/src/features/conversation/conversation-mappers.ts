import type {
  ConversationDetailResponse,
  ConversationSummaryResponse,
} from "../../api/conversations/conversation-contracts";
import type { ChatMessage, ConversationItem, ConversationSummary } from "./types";

export function toConversationSummary(response: ConversationSummaryResponse): ConversationSummary {
  return {
    id: response.id,
    title: response.title,
    updatedAt: response.updatedAtUtc,
  };
}

export function toConversationItems(response: ConversationDetailResponse): ConversationItem[] {
  return response.items.map((item): ConversationItem => {
    const message: ChatMessage = {
      id: item.id,
      role: item.role,
      body: item.text,
      createdAt: formatMessageCreatedAt(item.createdAtUtc),
    };

    return {
      type: "message",
      id: item.id,
      message,
    };
  });
}

export function formatMessageCreatedAt(createdAt = new Date().toISOString()): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Recently";

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
