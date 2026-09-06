import type {
  ConversationDetailResponse,
  ConversationHistoryItemResponse,
  ConversationSummaryResponse,
} from "../../api/conversations/conversation-contracts";
import type {
  AssistantTextBlock,
  ChatMessage,
  ConversationItem,
  ConversationResponseBlock,
  ConversationResponseItem,
  ConversationSummary,
  ToolExecutionBlock,
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

  const flushResponse = () => {
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

    const block = toResponseBlock(item);
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
): ConversationItem[] {
  const liveResponse = currentItems.find(
    (item): item is ConversationResponseItem =>
      item.type === "response" && item.id === liveResponseId,
  );
  if (liveResponse === undefined) return durableItems;

  const durableResponseIndex = findLastResponseIndex(durableItems);
  if (durableResponseIndex === -1) return durableItems;

  const durableResponse = durableItems[durableResponseIndex];
  if (durableResponse.type !== "response") return durableItems;

  const reconciledResponse: ConversationResponseItem = {
    ...durableResponse,
    id: liveResponse.id,
    status: liveResponse.status === "completed" ? durableResponse.status : liveResponse.status,
    blocks: reconcileResponseBlocks(liveResponse.blocks, durableResponse.blocks),
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

function toResponseBlock(item: ConversationHistoryItemResponse): ConversationResponseBlock | undefined {
  if (item.type === "message") {
    if (item.role !== "assistant") return undefined;
    return {
      type: "assistant_text",
      id: `assistant-${item.id}`,
      text: item.text,
      completed: true,
      createdAt: formatMessageCreatedAt(item.createdAtUtc),
    } satisfies AssistantTextBlock;
  }

  return {
    type: "tool_execution",
    id: item.callId,
    callId: item.callId,
    name: item.name,
    status: item.status,
    createdAt: formatMessageCreatedAt(item.createdAtUtc),
  } satisfies ToolExecutionBlock;
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
    if (durableBlock.type === "tool_execution") {
      const liveTool = liveBlocks.find(
        (block): block is ToolExecutionBlock =>
          block.type === "tool_execution" && block.callId === durableBlock.callId,
      );
      return liveTool === undefined
        ? durableBlock
        : { ...durableBlock, id: liveTool.id };
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
