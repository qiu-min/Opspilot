import type { TurnStreamProjectionResponse } from "../../api/sessions/session-contracts";
import type { ToolDisplayInfo, TurnStreamEvent } from "../../api/sessions/turn-stream-contracts";

export type TurnStreamPhase = "idle" | "streaming" | "completed" | "error" | "cancelled";
export type TurnStreamAssistantMessage = { text: string; completed: boolean };
export type TurnStreamActivity = { type: "assistant-message"; messageIndex: number } | { type: "agent-execution"; batchId: string };
export type TurnStreamToolExecution = { batchId: string; callId: string; name: string; status: "queued" | "running" | "completed" | "failed"; display?: ToolDisplayInfo; startedAt?: string; completedAt?: string };
export type TurnStreamUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
export type TurnStreamCompaction = { status: "idle" | "running" | "completed"; reason: string | null; aborted: boolean; failed: boolean; willRetry: boolean };
export type TurnStreamState = {
  turnId: string;
  sessionId: string;
  phase: TurnStreamPhase;
  lastSequence: number;
  isThinking: boolean;
  assistantMessages: TurnStreamAssistantMessage[];
  activity: TurnStreamActivity[];
  toolExecutions: TurnStreamToolExecution[];
  usageEvents: TurnStreamUsage[];
  compaction: TurnStreamCompaction;
  completion: { sessionId: string; turnId: string; leafId: string | null; status: string } | null;
  startedAt?: string;
  completedAt?: string;
  error: string | null;
};

export class TurnStreamStateError extends Error {
  constructor(message: string) { super(message); this.name = "TurnStreamStateError"; }
}

export function createInitialTurnStreamState(turnId = "", sessionId = ""): TurnStreamState {
  return { turnId, sessionId, phase: "idle", lastSequence: -1, isThinking: false, assistantMessages: [], activity: [], toolExecutions: [], usageEvents: [], compaction: { status: "idle", reason: null, aborted: false, failed: false, willRetry: false }, completion: null, error: null };
}

/** Rehydrates only the active Turn UI from PR2's ephemeral projection snapshot. */
export function hydrateTurnStreamStateFromProjection(projection: TurnStreamProjectionResponse): TurnStreamState {
  const state = createInitialTurnStreamState(projection.turnId, projection.sessionId);
  const hasAssistant = projection.assistant.messageVisible || projection.assistant.text.length > 0;
  const assistantMessages = hasAssistant ? [{ text: projection.assistant.text, completed: false }] : [];
  const activity: TurnStreamActivity[] = hasAssistant ? [{ type: "assistant-message", messageIndex: 0 }] : [];
  const toolExecutions = projection.tools.map((tool) => ({ ...tool, batchId: `tool-batch-${tool.callId}` }));
  for (const tool of toolExecutions) if (!activity.some((item) => item.type === "agent-execution" && item.batchId === tool.batchId)) activity.push({ type: "agent-execution" as const, batchId: tool.batchId });
  return { ...state, phase: projection.status === "running" ? "streaming" : projection.status === "failed" ? "error" : projection.status === "cancelled" ? "cancelled" : "completed", lastSequence: projection.lastSequence, isThinking: projection.assistant.isThinking, assistantMessages, activity, toolExecutions, usageEvents: projection.usage === null ? [] : [projection.usage], compaction: { status: projection.compaction.status, reason: null, aborted: false, failed: false, willRetry: false }, ...(projection.startedAt === undefined ? {} : { startedAt: projection.startedAt }) };
}

export function reduceTurnStreamEvent(state: TurnStreamState, event: TurnStreamEvent): TurnStreamState {
  if (event.turnId !== state.turnId || event.sessionId !== state.sessionId) throw new TurnStreamStateError("TurnStreamEvent identity does not match state");
  if (event.sequence <= state.lastSequence) return state;
  const next = { ...state, lastSequence: event.sequence };
  switch (event.type) {
    case "turn_started": return { ...next, phase: "streaming", startedAt: next.startedAt ?? event.timestamp, error: null };
    case "assistant_thinking_started": return { ...next, phase: "streaming", isThinking: true };
    case "assistant_thinking_completed": return { ...next, isThinking: false };
    case "assistant_message_started": return { ...next, isThinking: false, assistantMessages: [...next.assistantMessages, { text: "", completed: false }], activity: [...next.activity, { type: "assistant-message", messageIndex: next.assistantMessages.length }] };
    case "assistant_text_delta": {
      const index = findActiveAssistant(next);
      const messages = [...next.assistantMessages];
      messages[index] = { ...messages[index], text: messages[index].text + event.delta };
      return { ...next, phase: "streaming", isThinking: false, assistantMessages: messages };
    }
    case "assistant_message_completed": {
      const index = findActiveAssistant(next);
      const messages = [...next.assistantMessages];
      messages[index] = { ...messages[index], completed: true };
      return { ...next, assistantMessages: messages, isThinking: false };
    }
    case "tool_queued": return updateTool(next, { batchId: event.batchId ?? `tool-batch-${event.callId}`, callId: event.callId, name: event.name, status: "queued", display: event.display });
    case "tool_started": return updateTool(next, { batchId: next.toolExecutions.find((tool) => tool.callId === event.callId)?.batchId ?? `tool-batch-${event.callId}`, callId: event.callId, name: event.name, status: "running", display: event.display, startedAt: event.timestamp });
    case "tool_completed": return updateTool(next, { batchId: next.toolExecutions.find((tool) => tool.callId === event.callId)?.batchId ?? `tool-batch-${event.callId}`, callId: event.callId, name: event.name, status: event.isError ? "failed" : "completed", display: event.display, completedAt: event.timestamp });
    case "compaction_started": return { ...next, compaction: { status: "running", reason: event.reason ?? null, aborted: false, failed: false, willRetry: false } };
    case "compaction_completed": return { ...next, compaction: { status: "completed", reason: event.reason ?? null, aborted: event.aborted ?? false, failed: event.failed ?? false, willRetry: event.willRetry ?? false } };
    case "usage": return { ...next, usageEvents: [...next.usageEvents, { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens }] };
    case "turn_completed": return { ...next, phase: "completed", isThinking: false, completedAt: next.completedAt ?? event.timestamp, completion: { sessionId: event.sessionId, turnId: event.turnId, leafId: event.resultLeafId, status: "completed" } };
    case "turn_failed": return { ...next, phase: "error", isThinking: false, completedAt: next.completedAt ?? event.timestamp, completion: { sessionId: event.sessionId, turnId: event.turnId, leafId: null, status: "failed" }, error: event.message };
    case "turn_cancelled": return { ...next, phase: "cancelled", isThinking: false, completedAt: next.completedAt ?? event.timestamp, completion: { sessionId: event.sessionId, turnId: event.turnId, leafId: null, status: "cancelled" } };
  }
}

function updateTool(state: TurnStreamState, tool: TurnStreamToolExecution): TurnStreamState {
  const index = state.toolExecutions.findIndex((item) => item.callId === tool.callId);
  const existing = index < 0 ? undefined : state.toolExecutions[index];
  const display = tool.display ?? existing?.display;
  const startedAt = existing?.startedAt ?? tool.startedAt;
  const completedAt = existing?.completedAt ?? tool.completedAt;
  const nextTool = { ...tool, ...(display === undefined ? {} : { display }), ...(startedAt === undefined ? {} : { startedAt }), ...(completedAt === undefined ? {} : { completedAt }) };
  const toolExecutions = index < 0 ? [...state.toolExecutions, nextTool] : state.toolExecutions.map((item, itemIndex) => itemIndex === index ? nextTool : item);
  const activity: TurnStreamActivity[] = state.activity.some((item) => item.type === "agent-execution" && item.batchId === tool.batchId) ? state.activity : [...state.activity, { type: "agent-execution" as const, batchId: tool.batchId }];
  return { ...state, toolExecutions, activity };
}
function findActiveAssistant(state: TurnStreamState): number {
  for (let index = state.assistantMessages.length - 1; index >= 0; index -= 1) if (!state.assistantMessages[index].completed) return index;
  throw new TurnStreamStateError("Assistant stream event requires an active message");
}
