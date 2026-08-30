import type { AgentMessage } from '@opspilot/agent-runtime';
import type {
  AssistantMessage,
  Context,
  Model,
  ModelGateway,
  TextContent,
} from '@opspilot/model-gateway';

import { estimateContextTokens, estimateTokens } from './context-accounting.js';
import type { CompactionSettings } from './compaction-settings.js';
import { createCompactionSummaryMessage } from './compaction-summary-message.js';
import type { SessionEntry } from '../session/session-types.js';

const COMPACTION_SYSTEM_PROMPT = `You summarize conversation history so another assistant can continue the work.
Preserve the user's goals, important decisions, constraints, completed work, current state, unfinished work, and facts needed for future turns.
Return only a concise plain-text summary. Do not return JSON.`;

/** Messages and the session boundary selected for one compaction attempt. */
export interface CompactionPreparation {
  readonly messagesToSummarize: readonly AgentMessage[];
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
}

/** Result produced by a successful compaction summary generation. */
export interface CompactionResult {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
}

/** Inputs required by a compaction service; entries must be the active branch. */
export interface CompactionInput {
  readonly entries: readonly SessionEntry[];
  readonly model: Model;
  readonly settings: CompactionSettings;
  readonly signal?: AbortSignal;
}

/** Generates a compaction result without persisting it. */
export interface CompactionService {
  compact(input: CompactionInput): Promise<CompactionResult | undefined>;
}

/** Prepares a safe summary boundary from the current active branch. */
export function prepareCompaction(
  entries: readonly SessionEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  const projection = buildCurrentProjection(entries);
  if (projection.messages.length === 0) return undefined;

  const tokensBefore = estimateContextTokens(
    projection.messages.map((item) => item.message),
  ).tokens;
  const cutIndex = findSafeCutIndex(projection.messages, settings.keepRecentTokens);
  if (cutIndex === undefined) return undefined;

  const cutPoint = projection.messages[cutIndex];
  if (cutPoint.entryIndex === null) return undefined;

  const messagesToSummarize = projection.messages
    .slice(0, cutIndex)
    .map((item) => item.message);
  const hasNewHistoryToSummarize =
    projection.latestCompactionIndex === null
      ? messagesToSummarize.length > 0
      : projection.messages
          .slice(0, cutIndex)
          .some(
            (item) =>
              item.entryIndex !== null && item.entryIndex > projection.latestCompactionIndex!,
          );

  if (!hasNewHistoryToSummarize) return undefined;

  return {
    messagesToSummarize,
    firstKeptEntryId: entries[cutPoint.entryIndex].id,
    tokensBefore,
  };
}

/** Compaction service that summarizes prepared history through ModelGateway.complete(). */
export class DefaultCompactionService implements CompactionService {
  private readonly modelGateway: ModelGateway;

  /** Creates a service backed by the application's model gateway. */
  public constructor(modelGateway: ModelGateway) {
    this.modelGateway = modelGateway;
  }

  /** Generates a plain-text summary or returns undefined when there is nothing to compact. */
  public async compact(input: CompactionInput): Promise<CompactionResult | undefined> {
    const preparation = prepareCompaction(input.entries, input.settings);
    if (preparation === undefined) return undefined;

    const response = await this.modelGateway.complete(
      input.model,
      createSummaryContext(preparation.messagesToSummarize),
      input.signal === undefined ? undefined : { signal: input.signal },
    );

    if (response.finishReason === 'error' || response.finishReason === 'aborted') {
      throw new Error(`Compaction summary generation failed: ${response.finishReason}.`);
    }

    const summary = extractText(response).trim();
    if (summary.length === 0) throw new Error('Compaction summary must contain non-empty text.');

    return {
      summary,
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
    };
  }
}

interface ProjectedMessage {
  readonly message: AgentMessage;
  readonly entryIndex: number | null;
}

interface CurrentProjection {
  readonly messages: readonly ProjectedMessage[];
  readonly latestCompactionIndex: number | null;
}

function buildCurrentProjection(entries: readonly SessionEntry[]): CurrentProjection {
  const latestCompactionIndex = findLatestCompactionIndex(entries);
  if (latestCompactionIndex === null) {
    return {
      messages: entries.flatMap((entry, entryIndex) =>
        entry.type === 'message' ? [{ message: entry.message, entryIndex }] : [],
      ),
      latestCompactionIndex: null,
    };
  }

  const compaction = entries[latestCompactionIndex];
  if (compaction.type !== 'compaction') {
    throw new Error('Latest compaction entry could not be resolved.');
  }

  const firstKeptIndex = entries.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
  if (firstKeptIndex < 0 || firstKeptIndex > latestCompactionIndex) {
    throw new Error(
      `Compaction firstKeptEntryId is not an ancestor of the compaction: ${compaction.firstKeptEntryId}`,
    );
  }

  const messages: ProjectedMessage[] = [
    { message: createCompactionSummaryMessage(compaction.summary), entryIndex: null },
  ];
  for (let entryIndex = firstKeptIndex; entryIndex < entries.length; entryIndex += 1) {
    const entry = entries[entryIndex];
    if (entry.type === 'message') messages.push({ message: entry.message, entryIndex });
  }

  return { messages, latestCompactionIndex };
}

function findLatestCompactionIndex(entries: readonly SessionEntry[]): number | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].type === 'compaction') return index;
  }
  return null;
}

function findSafeCutIndex(
  messages: readonly ProjectedMessage[],
  keepRecentTokens: number,
): number | undefined {
  let accumulatedTokens = 0;
  let thresholdIndex: number | undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const messageTokens = estimateTokens(messages[index].message);
    if (messageTokens === 0) continue;

    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      thresholdIndex = index;
      break;
    }
  }

  if (thresholdIndex === undefined) return undefined;

  for (let index = thresholdIndex; index < messages.length; index += 1) {
    if (isSafeCutPoint(messages[index])) return index;
  }

  for (let index = thresholdIndex - 1; index >= 0; index -= 1) {
    if (isSafeCutPoint(messages[index])) return index;
  }

  return undefined;
}

function isSafeCutPoint(projectedMessage: ProjectedMessage): boolean {
  return (
    projectedMessage.entryIndex !== null &&
    (projectedMessage.message.role === 'user' || projectedMessage.message.role === 'assistant')
  );
}

function createSummaryContext(messages: readonly AgentMessage[]): Context {
  const transcript = messages.map(serializeMessage).join('\n\n');
  return {
    systemPrompt: COMPACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text:
              'Summarize the following conversation history for future continuation.\n\n' +
              `<conversation>\n${transcript}\n</conversation>`,
          },
        ],
      },
    ],
  };
}

function serializeMessage(message: AgentMessage): string {
  if (message.role === 'user') {
    return `User:\n${message.content.map((content) => content.text).join('\n')}`;
  }

  if (message.role === 'assistant') {
    return serializeAssistantMessage(message);
  }

  if (message.role === 'tool') {
    return `Tool result (${message.name}, call ${message.callId}):\n${message.content
      .map((content) => content.text)
      .join('\n')}`;
  }

  return `Message:\n${serializeSafely(message) ?? '[unserializable message]'}`;
}

function serializeAssistantMessage(message: AssistantMessage): string {
  const sections: string[] = [];
  for (const content of message.content) {
    if (content.type === 'text') sections.push(`Text:\n${content.text}`);
    else if (content.type === 'thinking') sections.push(`Thinking:\n${content.thinking}`);
  }

  for (const toolCall of message.toolCalls ?? []) {
    sections.push(
      `Tool call ${toolCall.name}: ${serializeSafely(toolCall.arguments) ?? '[unserializable arguments]'}`,
    );
  }

  return `Assistant:\n${sections.join('\n')}`;
}

function extractText(message: AssistantMessage): string {
  return message.content
    .filter((content): content is TextContent => content.type === 'text')
    .map((content) => content.text)
    .join('\n');
}

function serializeSafely(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
