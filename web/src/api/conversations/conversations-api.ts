import { apiRequest } from "../client";
import type {
  ConversationSummaryResponse,
  CreateConversationResponse,
  RunConversationTurnRequest,
  RunConversationTurnResponse,
} from "./conversation-contracts";

export function listConversations(
  accessToken: string,
  signal?: AbortSignal,
): Promise<ConversationSummaryResponse[]> {
  return apiRequest<ConversationSummaryResponse[]>("/api/conversations", {
    method: "GET",
    accessToken,
    signal,
  });
}

export function createConversation(
  accessToken: string,
  signal?: AbortSignal,
): Promise<CreateConversationResponse> {
  return apiRequest<CreateConversationResponse>("/api/conversations", {
    method: "POST",
    accessToken,
    signal,
  });
}

export function runConversationTurn(
  conversationId: string,
  request: RunConversationTurnRequest,
  accessToken: string,
  signal?: AbortSignal,
): Promise<RunConversationTurnResponse> {
  return apiRequest<RunConversationTurnResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns`,
    {
      method: "POST",
      body: request,
      accessToken,
      signal,
    },
  );
}
