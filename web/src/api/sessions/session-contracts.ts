export type SessionSummaryResponse = {
  id: string;
  title: string;
  updatedAtUtc: string;
};

export type SessionDetailResponse = {
  id: string;
  title: string;
  createdAtUtc: string;
  updatedAtUtc: string;
  items: SessionHistoryItemResponse[];
};

export type SessionHistoryItemResponse =
  | { type: "message"; id: string; role: "user" | "assistant"; text: string; createdAtUtc: string }
  | { type: "tool_execution"; id: string; callId: string; name: string; status: "completed" | "failed"; createdAtUtc: string };

export type CreateSessionResponse = {
  id: string;
  title: string;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type RunSessionTurnRequest = { fileId?: string | null; message: string };
export type RunSessionTurnResponse = { sessionId: string; turnId: string; leafId: string | null; status: string; output: string };

export type TurnStreamProjectionResponse = {
  turnId: string;
  sessionId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt?: string;
  assistant: { text: string; messageVisible: boolean; isThinking: boolean };
  tools: Array<{ callId: string; name: string; status: "queued" | "running" | "completed" | "failed"; display?: ToolDisplayInfo; startedAt?: string; completedAt?: string }>;
  compaction: { status: "idle" | "running" };
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  lastSequence: number;
};

export type ActiveTurnResponse = {
  activeTurn: { turnId: string; sessionId: string; status: "running"; projection: TurnStreamProjectionResponse } | null;
};
import type { ToolDisplayInfo } from "./turn-stream-contracts";
