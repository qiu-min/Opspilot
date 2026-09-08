import type { AgentMessage, AgentThinkingLevel } from '@opspilot/agent-runtime';

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

/** A message recorded in the Session history. */
export interface SessionMessageEntry extends SessionEntryBase {
  readonly type: 'message';
  readonly message: AgentMessage;
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
  readonly thinkingLevel: AgentThinkingLevel;
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
const agentThinkingLevels: readonly AgentThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
];

export function isAgentThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === 'string' && agentThinkingLevels.includes(value as AgentThinkingLevel);
}
