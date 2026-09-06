import type {
  ConversationDetailResponse,
  ConversationHistoryItemResponse,
  ConversationSummaryResponse,
} from "../../api/conversations/conversation-contracts";
import type {
  AgentExecutionBlock,
  AssistantTextBlock,
  AgentExecutionStep,
  ChatMessage,
  ConversationItem,
  ConversationResponseBlock,
  ConversationResponseItem,
  ConversationSummary,
} from "./types";

export function toConversationSummary(response: ConversationSummaryResponse): ConversationSummary {
  return {
    id: response.id,
    title: response.title,
    updatedAt: response.updatedAtUtc,
  };
}

/** Projects the flat durable history into user items and ordered response containers. */
export function toConversationItems(response: ConversationDetailResponse): ConversationItem[] {
  const items: ConversationItem[] = [];
  let responseBlocks: ConversationResponseBlock[] = [];
  let responseIdSeed: string | null = null;
  let pendingToolSteps: AgentExecutionStep[] = [];

  const flushToolExecution = () => {
    if (pendingToolSteps.length === 0) return;

    const firstStep = pendingToolSteps[0];
    responseBlocks.push({
      type: "agent_execution",
      id: `execution-${firstStep.callId}`,
      batchId: `tool-batch-${firstStep.callId}`,
      steps: pendingToolSteps,
    });
    pendingToolSteps = [];
  };

  const flushResponse = () => {
    flushToolExecution();
    if (responseBlocks.length === 0) return;

    const responseId = `response-${responseIdSeed ?? responseBlocks[0].id}`;
    items.push({
      type: "response",
      id: responseId,
      status: "completed",
      blocks: responseBlocks,
    });
    responseBlocks = [];
    responseIdSeed = null;
  };

  for (const item of response.items) {
    if (item.type === "message" && item.role === "user") {
      flushResponse();
      const message = toChatMessage(item);
      items.push({ type: "message", id: item.id, message });
      responseIdSeed = item.id;
      continue;
    }

    if (item.type === "tool_execution") {
      if (responseIdSeed === null) responseIdSeed = item.id;
      pendingToolSteps.push(toToolExecutionStep(item));
      continue;
    }

    flushToolExecution();
    const block = toAssistantTextBlock(item);
    if (block === undefined) continue;
    if (responseIdSeed === null) responseIdSeed = block.id;
    responseBlocks.push(block);
  }

  flushResponse();
  return items;
}

/** Reconciles a completed durable timeline while preserving the live response identity. */
export function reconcileConversationItems(
  currentItems: ConversationItem[],
  durableItems: ConversationItem[],
  liveResponseId: string,
  liveResponse?: ConversationResponseItem,
): ConversationItem[] {
  const currentLiveResponse = liveResponse ?? currentItems.find(
    (item): item is ConversationResponseItem =>
      item.type === "response" && item.id === liveResponseId,
  );
  if (currentLiveResponse === undefined) return durableItems;

  const durableResponseIndex = findLastResponseIndex(durableItems);
  if (durableResponseIndex === -1) return durableItems;

  const durableResponse = durableItems[durableResponseIndex];
  if (durableResponse.type !== "response") return durableItems;

  const reconciledResponse: ConversationResponseItem = {
    ...durableResponse,
    id: currentLiveResponse.id,
    status: currentLiveResponse.status === "completed" ? durableResponse.status : currentLiveResponse.status,
    blocks: reconcileResponseBlocks(currentLiveResponse.blocks, durableResponse.blocks),
  };
  const reconciledItems = [...durableItems];
  reconciledItems[durableResponseIndex] = reconciledResponse;
  return reconciledItems;
}

export function formatMessageCreatedAt(createdAt = new Date().toISOString()): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "Recently";

  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Adds the current live response to the committed timeline for rendering only. */
export function mergeLiveConversationResponse(
  durableItems: ConversationItem[],
  liveResponse: ConversationResponseItem | undefined,
  liveResponseId: string | undefined,
): ConversationItem[] {
  if (liveResponse === undefined || liveResponseId === undefined) return durableItems;

  const responseIndex = durableItems.findIndex(
    (item) => item.type === "response" && item.id === liveResponseId,
  );
  if (responseIndex !== -1) {
    const nextItems = [...durableItems];
    nextItems[responseIndex] = liveResponse;
    return nextItems;
  }

  return [...durableItems, liveResponse];
}

function toAssistantTextBlock(
  item: Extract<ConversationHistoryItemResponse, { type: "message" }>,
): AssistantTextBlock | undefined {
  if (item.role !== "assistant") return undefined;
  return {
    type: "assistant_text",
    id: `assistant-${item.id}`,
    text: item.text,
    completed: true,
  } satisfies AssistantTextBlock;
}

function toToolExecutionStep(
  item: Extract<ConversationHistoryItemResponse, { type: "tool_execution" }>,
): AgentExecutionStep {
  return {
    id: item.callId,
    callId: item.callId,
    name: item.name,
    status: item.status,
  } satisfies AgentExecutionStep;
}

function toChatMessage(item: Extract<ConversationHistoryItemResponse, { type: "message" }>): ChatMessage {
  return {
    id: item.id,
    role: item.role,
    body: item.text,
    createdAt: formatMessageCreatedAt(item.createdAtUtc),
  };
}

function findLastResponseIndex(items: ConversationItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].type === "response") return index;
  }

  return -1;
}

function reconcileResponseBlocks(
  liveBlocks: ConversationResponseBlock[],
  durableBlocks: ConversationResponseBlock[],
): ConversationResponseBlock[] {
  let assistantBlockIndex = 0;
  return durableBlocks.map((durableBlock) => {
    if (durableBlock.type === "agent_execution") {
      const durableFirstCallId = durableBlock.steps[0]?.callId;
      const liveExecution = liveBlocks.find(
        (block): block is AgentExecutionBlock =>
          block.type === "agent_execution" &&
          block.steps[0]?.callId === durableFirstCallId,
      );
      return liveExecution === undefined
        ? durableBlock
        : { ...durableBlock, id: liveExecution.id, batchId: liveExecution.batchId };
    }

    const liveAssistantBlocks = liveBlocks.filter(
      (block): block is AssistantTextBlock => block.type === "assistant_text",
    );
    const liveAssistant = liveAssistantBlocks[assistantBlockIndex];
    assistantBlockIndex += 1;
    return liveAssistant === undefined
      ? durableBlock
      : { ...durableBlock, id: liveAssistant.id };
  });
}
