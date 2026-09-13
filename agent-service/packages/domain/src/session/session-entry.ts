import type { ModelFailureSnapshot } from '../model/model-failure.js';

/** The durable identity and creation metadata for a Session aggregate. */
export interface SessionHeader {
  readonly type: 'session';
  readonly version: number;
  readonly id: string;
  readonly timestamp: string;
}

/** Common tree metadata shared by every Session entry. */
export interface SessionEntryBase {
  readonly type: string;
  readonly id: string;
  readonly parentId: string | null;
  readonly timestamp: string;
}

/** Thinking levels persisted as part of a Session history. */
export type SessionThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

/** Finish reasons persisted on assistant messages. */
export type SessionFinishReason =
  'pending' | 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error' | 'aborted';

/** Text content persisted in user, assistant, and tool messages. */
export interface SessionTextContent {
  readonly type: 'text';
  readonly text: string;
}

/** Private reasoning content persisted in assistant messages. */
export interface SessionThinkingContent {
  readonly type: 'thinking';
  readonly thinking: string;
  readonly thinkingSignature: 'reasoning_content' | 'reasoning' | 'reasoning_text';
  readonly source: {
    readonly api: string;
    readonly provider: string;
    readonly model: string;
  };
}

/** Tool call data persisted in an assistant message. */
export interface SessionToolCall {
  readonly callId: string;
  readonly name: string;
  readonly arguments: { readonly [key: string]: unknown };
}

/** Usage data persisted in an assistant message. */
export interface SessionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Domain-owned name for the model failure snapshot persisted with an assistant message. */
export type SessionModelErrorInfo = ModelFailureSnapshot;

/** Reasoning selection metadata persisted in an assistant message. */
export interface SessionReasoningDecision {
  readonly requested: 'minimal' | 'low' | 'medium' | 'high';
  readonly selected: SessionThinkingLevel;
}

/** A user message stored in Session history. */
export interface SessionUserMessage {
  readonly role: 'user';
  readonly content: readonly SessionTextContent[];
}

/** An assistant message stored in Session history. */
export interface SessionAssistantMessage {
  readonly role: 'assistant';
  readonly api: string;
  readonly provider: string;
  readonly model: string;
  readonly content: readonly (SessionTextContent | SessionThinkingContent)[];
  readonly toolCalls?: readonly SessionToolCall[];
  readonly finishReason: SessionFinishReason;
  readonly errorMessage?: string;
  readonly modelError?: SessionModelErrorInfo;
  readonly rawFinishReason?: string;
  readonly usage?: SessionUsage;
  readonly responseId?: string;
  readonly reasoning?: SessionReasoningDecision;
}

/** A tool result stored in Session history. */
export interface SessionToolResultMessage {
  readonly role: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly content: readonly SessionTextContent[];
  readonly details?: unknown;
  readonly isError: boolean;
}

/** A model message owned by the Session persistence model. */
export type SessionMessage =
  SessionUserMessage | SessionAssistantMessage | SessionToolResultMessage;

/** A message recorded in the Session history. */
export interface SessionMessageEntry extends SessionEntryBase {
  readonly type: 'message';
  readonly message: SessionMessage;
}

/** A branch-local model selection change. */
export interface ModelChangeEntry extends SessionEntryBase {
  readonly type: 'model_change';
  readonly provider: string;
  readonly modelId: string;
}

/** A branch-local thinking-level selection change. */
export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  readonly type: 'thinking_level_change';
  readonly thinkingLevel: SessionThinkingLevel;
}

/** A durable summary boundary that preserves all original entries. */
export interface CompactionEntry extends SessionEntryBase {
  readonly type: 'compaction';
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
}

/** All entry kinds owned by the Session domain. */
export type SessionEntry =
  SessionMessageEntry | ModelChangeEntry | ThinkingLevelChangeEntry | CompactionEntry;

/** Valid thinking levels accepted by the Session domain. */
const sessionThinkingLevels: readonly SessionThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
];

/** Checks whether a persisted thinking-level value is supported by Session. */
export function isSessionThinkingLevel(value: unknown): value is SessionThinkingLevel {
  return typeof value === 'string' && sessionThinkingLevels.includes(value as SessionThinkingLevel);
}
