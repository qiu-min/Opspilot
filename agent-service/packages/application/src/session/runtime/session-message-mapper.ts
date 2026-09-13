import type { AgentMessage, AgentThinkingLevel } from '@opspilot/agent-runtime';
import { messageSchema } from '@opspilot/model-gateway';
import {
  isSessionThinkingLevel,
  type SessionMessage,
  type SessionThinkingLevel,
} from '@opspilot/domain';

/** Converts a standard Runtime message into the Session persistence model. */
export function toSessionMessage(message: AgentMessage): SessionMessage | undefined {
  const parsed = messageSchema.safeParse(message);
  return parsed.success ? structuredClone(parsed.data) : undefined;
}

/** Converts a Runtime message that must be persisted, failing for custom messages. */
export function requireSessionMessage(message: AgentMessage): SessionMessage {
  const sessionMessage = toSessionMessage(message);
  if (sessionMessage === undefined) {
    throw new Error('Only standard Agent Runtime messages can be persisted in Session history.');
  }
  return sessionMessage;
}

/** Converts a persisted Session message into an Agent Runtime message. */
export function toAgentMessage(message: SessionMessage): AgentMessage {
  return structuredClone(message);
}

/** Converts a Runtime thinking level into the Session persistence model. */
export function toSessionThinkingLevel(level: AgentThinkingLevel): SessionThinkingLevel {
  if (!isSessionThinkingLevel(level)) {
    throw new Error(`Unsupported thinking level: ${String(level)}.`);
  }
  return level;
}

/** Converts a persisted Session thinking level into the Runtime model. */
export function toAgentThinkingLevel(level: SessionThinkingLevel): AgentThinkingLevel {
  return level;
}
