import { apiFetch, apiRequest } from "../client";
import {
  ConversationStreamProtocolError,
  type ConversationStreamEvent,
} from "./conversation-stream-contracts";
import { parseConversationSseStream } from "./conversation-sse-parser";
import type {
  ConversationDetailResponse,
  ConversationSummaryResponse,
  CreateConversationResponse,
  RunConversationTurnRequest,
  RunConversationTurnResponse,
} from "./conversation-contracts";

export function getConversation(
  conversationId: string,
  accessToken: string,
  signal?: AbortSignal,
): Promise<ConversationDetailResponse> {
  return apiRequest<ConversationDetailResponse>(
    `/api/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "GET",
      accessToken,
      signal,
    },
  );
}

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

export async function* streamConversationTurn(
  conversationId: string,
  request: RunConversationTurnRequest,
  accessToken: string,
  signal?: AbortSignal,
): AsyncGenerator<ConversationStreamEvent> {
  const response = await apiFetch(
    `/api/conversations/${encodeURIComponent(conversationId)}/turns/stream`,
    {
      method: "POST",
      body: request,
      accessToken,
      signal,
      headers: {
        Accept: "text/event-stream",
      },
    },
  );

  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") {
    throw new ConversationStreamProtocolError(
      "Conversation stream response must use content type text/event-stream.",
    );
  }

  if (response.body === null) {
    throw new ConversationStreamProtocolError(
      "Conversation stream response does not contain a readable body.",
    );
  }

  let firstEvent = true;
  let terminalEventReceived = false;

  for await (const event of parseConversationSseStream(response.body)) {
    if (firstEvent) {
      firstEvent = false;
      if (event.type !== "response_started") {
        throw new ConversationStreamProtocolError(
          "The first conversation stream event must be response_started.",
        );
      }
    }

    yield event;

    if (event.type === "response_completed" || event.type === "error") {
      terminalEventReceived = true;
      return;
    }
  }

  if (firstEvent || !terminalEventReceived) {
    throw new ConversationStreamProtocolError(
      "Conversation stream ended without a terminal event.",
    );
  }
}
