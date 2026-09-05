import type { AgentMessage } from '@opspilot/agent-runtime';

import type { SessionEntry } from '../session/session-types.js';

/** A UI-safe history item projected from one persisted session message entry. */
export interface ConversationHistoryMessageItem {
  readonly type: 'message';
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly createdAt: string;
}

/** The extensible item union returned to the conversation history boundary. */
export type ConversationHistoryItem = ConversationHistoryMessageItem;

/** The durable history projection for the active branch of a session. */
export interface ConversationHistoryProjection {
  readonly leafId: string | null;
  readonly items: readonly ConversationHistoryItem[];
}

/**
 * Builds the user-visible history projection from an already selected session branch.
 *
 * The caller must obtain entries with SessionManager.getBranch(). This projection is
 * intentionally independent from buildSessionContext(), so compaction never removes
 * durable messages from the history shown in the Web UI.
 */
export function buildConversationHistoryProjection(
  branch: readonly SessionEntry[],
  leafId: string | null = branch.at(-1)?.id ?? null,
): ConversationHistoryProjection {
  const items = branch.flatMap((entry) => {
    if (entry.type !== 'message') return [];

    const message = getVisibleMessage(entry.message);
    if (message === undefined) return [];
    const text = extractVisibleText(message);
    if (text.length === 0) return [];

    return [
      {
        type: 'message' as const,
        id: entry.id,
        role: message.role,
        text,
        createdAt: entry.timestamp,
      },
    ];
  });

  return { leafId, items };
}

/** Extracts only public text content and deliberately excludes thinking content. */
export function extractVisibleText(
  message: Extract<AgentMessage, { readonly role: 'user' | 'assistant' }>,
): string {
  return message.content
    .flatMap((content) => (content.type === 'text' ? [content.text] : []))
    .join('');
}

function getVisibleMessage(
  message: AgentMessage,
): Extract<AgentMessage, { readonly role: 'user' | 'assistant' }> | undefined {
  return message.role === 'user' || message.role === 'assistant' ? message : undefined;
}
