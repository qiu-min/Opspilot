import type { AgentMessage, AgentThinkingLevel } from '@opspilot/agent-runtime';

export interface SessionHeader {
  type: 'session';
  version: number;
  id: string;
  timestamp: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message';
  message: AgentMessage;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: 'model_change';
  provider: string;
  modelId: string;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: 'thinking_level_change';
  thinkingLevel: AgentThinkingLevel;
}

export interface CompactionEntry extends SessionEntryBase {
  readonly type: 'compaction';
  readonly summary: string;
  readonly firstKeptEntryId: string;
  readonly tokensBefore: number;
}

export type SessionEntry =
  | SessionMessageEntry
  | ModelChangeEntry
  | ThinkingLevelChangeEntry
  | CompactionEntry;

export type SessionFileEntry = SessionHeader | SessionEntry;

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: AgentThinkingLevel;
  model: {
    provider: string;
    modelId: string;
  } | null;
}
