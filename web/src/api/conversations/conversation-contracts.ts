export type ConversationSummaryResponse = {
  id: string;
  title: string;
  updatedAtUtc: string;
};

export type ConversationDetailResponse = {
  id: string;
  title: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  items: ConversationHistoryItemResponse[];
};

export type ConversationHistoryItemResponse =
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      text: string;
      createdAtUtc: string;
    }
  | {
      type: "tool_execution";
      id: string;
      callId: string;
      name: string;
      status: "completed" | "failed";
      createdAtUtc: string;
    };

export type CreateConversationResponse = {
  id: string;
  title: string;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type RunConversationTurnRequest = {
  fileId?: string | null;
  message: string;
};

export type RunConversationTurnResponse = {
  conversationId: string;
  leafId: string | null;
  status: string;
  output: string;
};
