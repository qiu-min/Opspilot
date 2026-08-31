import type { AgentMessage } from '@opspilot/agent-runtime';
import type {
  AssistantMessage,
  Context,
  Model,
  ModelGateway,
  TextContent,
} from '@opspilot/model-gateway';

import { estimateSessionContextTokens, estimateTokens } from './context-accounting.js';
import type { CompactionSettings } from './compaction-settings.js';
import {
  buildSessionMessageProjection,
  type SessionProjectedMessage,
} from '../session/session-projection.js';
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

/** Complete application-level result for a committed compaction operation. */
export interface CompactionResult {
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
}

/** Inputs required to summarize messages already selected by the Application. */
export interface CompactionSummaryInput {
  readonly messages: readonly AgentMessage[];
  readonly model: Model;
  readonly signal?: AbortSignal;
}

/** Generates a summary for prepared messages without choosing or persisting a boundary. */
export interface CompactionService {
  compact(input: CompactionSummaryInput): Promise<CompactionSummaryResult>;
}

/** Result produced by a successful compaction summary generation. */
export interface CompactionSummaryResult {
  readonly summary: string;
}

/** Prepares a safe summary boundary from the current active branch. */
export function prepareCompaction(
  entries: readonly SessionEntry[],
  settings: CompactionSettings,
): CompactionPreparation | undefined {
  const projection = buildSessionMessageProjection(entries);
  if (projection.messages.length === 0) return undefined;

  const tokensBefore = estimateSessionContextTokens(entries).tokens;
  const cutIndex = findSafeCutIndex(projection.messages, settings.keepRecentTokens);
  if (cutIndex === undefined) return undefined;

  const cutPoint = projection.messages[cutIndex];
  if (cutPoint.entryIndex === null) return undefined;

  const messagesToSummarize = projection.messages.slice(0, cutIndex).map((item) => item.message);
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

/** Compaction service that summarizes prepared messages through ModelGateway.complete(). */
export class DefaultCompactionService implements CompactionService {
  private readonly modelGateway: ModelGateway;

  /** Creates a service backed by the application's model gateway. */
  public constructor(modelGateway: ModelGateway) {
    this.modelGateway = modelGateway;
  }

  /** Generates a plain-text summary for the messages supplied by the Application. */
  public async compact(input: CompactionSummaryInput): Promise<CompactionSummaryResult> {
    const response = await this.modelGateway.complete(
      input.model,
      createSummaryContext(input.messages),
      input.signal === undefined ? undefined : { signal: input.signal },
    );

    if (response.finishReason === 'error' || response.finishReason === 'aborted') {
      throw new Error(`Compaction summary generation failed: ${response.finishReason}.`);
    }

    const summary = extractText(response).trim();
    if (summary.length === 0) throw new Error('Compaction summary must contain non-empty text.');

    return { summary };
  }
}

function findSafeCutIndex(
  messages: readonly SessionProjectedMessage[],
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

function isSafeCutPoint(projectedMessage: SessionProjectedMessage): boolean {
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
