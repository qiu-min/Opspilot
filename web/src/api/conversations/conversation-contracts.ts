export type ConversationSummaryResponse = {
  id: string;
  title: string;
  updatedAtUtc: string;
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
