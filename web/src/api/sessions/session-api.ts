import { apiFetch, apiRequest } from "../client";
import { TurnStreamProtocolError, type TurnStreamEvent } from "./turn-stream-contracts";
import { parseTurnSseStream } from "./turn-sse-parser";
import type { ActiveTurnResponse, CreateSessionResponse, RunSessionTurnRequest, RunSessionTurnResponse, SessionDetailResponse, SessionSummaryResponse } from "./session-contracts";

export function getSession(sessionId: string, accessToken: string, signal?: AbortSignal): Promise<SessionDetailResponse> {
  return apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "GET", accessToken, signal, cache: "no-store" });
}
export function listSessions(accessToken: string, signal?: AbortSignal): Promise<SessionSummaryResponse[]> {
  return apiRequest("/api/sessions", { method: "GET", accessToken, signal, cache: "no-store" });
}
export function createSession(accessToken: string, signal?: AbortSignal): Promise<CreateSessionResponse> {
  return apiRequest("/api/sessions", { method: "POST", accessToken, signal });
}
export function runSessionTurn(sessionId: string, request: RunSessionTurnRequest, accessToken: string, signal?: AbortSignal): Promise<RunSessionTurnResponse> {
  return apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, { method: "POST", body: request, accessToken, signal });
}
export function getActiveSessionTurn(sessionId: string, accessToken: string, signal?: AbortSignal): Promise<ActiveTurnResponse> {
  return apiRequest(`/api/sessions/${encodeURIComponent(sessionId)}/active-turn`, { method: "GET", accessToken, signal, cache: "no-store" });
}

export async function* startSessionTurnStream(sessionId: string, request: RunSessionTurnRequest, accessToken: string, signal?: AbortSignal): AsyncGenerator<TurnStreamEvent> {
  yield* readTurnStream(`/api/sessions/${encodeURIComponent(sessionId)}/turns/stream`, "start", request, accessToken, signal);
}

export async function* reattachSessionTurnStream(sessionId: string, turnId: string, after: number | undefined, accessToken: string, signal?: AbortSignal): AsyncGenerator<TurnStreamEvent> {
  const query = after === undefined ? "" : `?after=${encodeURIComponent(String(after))}`;
  yield* readTurnStream(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/stream${query}`, "reattach", undefined, accessToken, signal);
}

async function* readTurnStream(path: string, mode: "start" | "reattach", body: RunSessionTurnRequest | undefined, accessToken: string, signal?: AbortSignal): AsyncGenerator<TurnStreamEvent> {
  const response = await apiFetch(path, { method: mode === "start" ? "POST" : "GET", body, accessToken, signal, cache: "no-store", headers: { Accept: "text/event-stream" } });
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") throw new TurnStreamProtocolError("Turn stream response must use content type text/event-stream.");
  if (response.body === null) throw new TurnStreamProtocolError("Turn stream response has no readable body.");
  for await (const event of parseTurnSseStream(response.body)) yield event;
}
