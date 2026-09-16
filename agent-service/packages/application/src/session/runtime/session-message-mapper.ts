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
  if (!parsed.success) return undefined;
  if (parsed.data.role === 'tool') {
    return structuredClone({
      role: parsed.data.role,
      callId: parsed.data.callId,
      name: parsed.data.name,
      content: parsed.data.content,
      isError: parsed.data.isError,
    });
  }
  return structuredClone(parsed.data);
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
  if (message.role === 'tool') {
    return structuredClone({
      role: message.role,
      callId: message.callId,
      name: message.name,
      content: message.content,
      isError: message.isError,
    });
  }
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
