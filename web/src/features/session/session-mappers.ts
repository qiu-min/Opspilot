import type { SessionDetailResponse, SessionHistoryItemResponse, SessionSummaryResponse } from "../../api/sessions/session-contracts";
import type { AgentExecutionBlock, AssistantTextBlock, AgentExecutionStep, ChatMessage, SessionItem, SessionSummary, TurnResponseBlock, TurnResponseItem } from "./types";

export function toSessionSummary(response: SessionSummaryResponse): SessionSummary { return { id: response.id, title: response.title, updatedAt: response.updatedAtUtc }; }

/** Projects durable Agent Service history into the existing visual timeline. */
export function toSessionItems(response: SessionDetailResponse): SessionItem[] {
  const items: SessionItem[] = [];
  let blocks: TurnResponseBlock[] = [];
  let responseIdSeed: string | null = null;
  let tools: AgentExecutionStep[] = [];
  const flushTools = () => { if (tools.length === 0) return; const first = tools[0]; blocks.push({ type: "agent_execution", id: `execution-${first.callId}`, batchId: `tool-batch-${first.callId}`, steps: tools }); tools = []; };
  const flushResponse = () => { flushTools(); if (blocks.length === 0) return; items.push({ type: "response", id: `response-${responseIdSeed ?? blocks[0].id}`, status: "completed", blocks }); blocks = []; responseIdSeed = null; };
  for (const item of response.items) {
    if (item.type === "message" && item.role === "user") { flushResponse(); items.push({ type: "message", id: item.id, message: toChatMessage(item) }); responseIdSeed = item.id; continue; }
    if (item.type === "tool_execution") { if (responseIdSeed === null) responseIdSeed = item.id; tools.push(toToolStep(item)); continue; }
    flushTools(); const block = toAssistantBlock(item); if (block === undefined) continue; if (responseIdSeed === null) responseIdSeed = block.id; blocks.push(block);
  }
  flushResponse();
  return items;
}

export function mergeLiveTurnResponse(durableItems: SessionItem[], liveResponse: TurnResponseItem | undefined, liveResponseId: string | undefined): SessionItem[] {
  if (liveResponse === undefined || liveResponseId === undefined) return durableItems;
  const index = durableItems.findIndex((item) => item.type === "response" && (item.id === liveResponseId || hasSharedToolCall(item, liveResponse)));
  if (index < 0) return [...durableItems, liveResponse];
  const next = [...durableItems];
  next[index] = mergeResponseBlocks(next[index] as TurnResponseItem, liveResponse);
  return next;
}

/** Durable history is authoritative after terminal events; live blocks only preserve current UI identity. */
export function reconcileSessionItems(durableItems: SessionItem[], liveResponseId?: string, liveResponse?: TurnResponseItem): SessionItem[] {
  if (liveResponseId === undefined || liveResponse === undefined) return durableItems;
  return mergeLiveTurnResponse(durableItems, liveResponse, liveResponseId);
}
export function formatMessageCreatedAt(createdAt = new Date().toISOString()): string { const date = new Date(createdAt); return Number.isNaN(date.getTime()) ? "Recently" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date); }

function toAssistantBlock(item: Extract<SessionHistoryItemResponse, { type: "message" }>): AssistantTextBlock | undefined { return item.role === "assistant" ? { type: "assistant_text", id: `assistant-${item.id}`, text: item.text, completed: true } : undefined; }
function toToolStep(item: Extract<SessionHistoryItemResponse, { type: "tool_execution" }>): AgentExecutionStep { return { id: item.callId, callId: item.callId, name: item.name, status: item.status }; }
function toChatMessage(item: Extract<SessionHistoryItemResponse, { type: "message" }>): ChatMessage { return { id: item.id, role: item.role, body: item.text, createdAt: formatMessageCreatedAt(item.createdAtUtc) }; }

function mergeResponseBlocks(durableResponse: TurnResponseItem, liveResponse: TurnResponseItem): TurnResponseItem {
  const durableCallIds = new Set(
    durableResponse.blocks
      .filter((block): block is AgentExecutionBlock => block.type === "agent_execution")
      .flatMap((block) => block.steps.map((step) => step.callId)),
  );
  const liveStepsByCallId = new Map(
    liveResponse.blocks
      .filter((block): block is AgentExecutionBlock => block.type === "agent_execution")
      .flatMap((block) => block.steps)
      .map((step) => [step.callId, step] as const),
  );
  const enrichedDurableBlocks = durableResponse.blocks.map((block): TurnResponseBlock => {
    if (block.type !== "agent_execution") return block;
    return { ...block, steps: block.steps.map((step) => enrichDurableToolStep(step, liveStepsByCallId.get(step.callId))) };
  });
  const liveBlocks = liveResponse.blocks.flatMap<TurnResponseBlock>((block) => {
    if (block.type !== "agent_execution") return [block];
    const steps = block.steps.filter((step) => !durableCallIds.has(step.callId));
    return steps.length === 0 ? [] : [{ ...block, steps }];
  });
  const durableHasCompletedAssistant = durableResponse.blocks.some((block) => block.type === "assistant_text" && block.completed);
  const blocks: TurnResponseBlock[] = liveBlocks.filter((block) => block.type !== "assistant_text" || !block.completed || !durableHasCompletedAssistant);
  return { ...liveResponse, blocks: [...enrichedDurableBlocks, ...blocks] };
}

function enrichDurableToolStep(step: AgentExecutionStep, liveStep: AgentExecutionStep | undefined): AgentExecutionStep {
  if (liveStep === undefined) return step;
  return { ...step, ...(liveStep.display === undefined ? {} : { display: liveStep.display }), ...(liveStep.startedAt === undefined ? {} : { startedAt: liveStep.startedAt }), ...(liveStep.completedAt === undefined ? {} : { completedAt: liveStep.completedAt }) };
}

function hasSharedToolCall(durableResponse: TurnResponseItem, liveResponse: TurnResponseItem): boolean {
  const durableCallIds = new Set(
    durableResponse.blocks
      .filter((block): block is AgentExecutionBlock => block.type === "agent_execution")
      .flatMap((block) => block.steps.map((step) => step.callId)),
  );
  return liveResponse.blocks
    .filter((block): block is AgentExecutionBlock => block.type === "agent_execution")
    .some((block) => block.steps.some((step) => durableCallIds.has(step.callId)));
}
