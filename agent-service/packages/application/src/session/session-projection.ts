import type { AgentMessage } from '@opspilot/agent-runtime';

import { createCompactionSummaryMessage } from '../context/compaction-summary-message.js';
import type { SessionEntry } from './session-types.js';

/** A message projected from a session entry, retaining its source entry index. */
export interface SessionProjectedMessage {
  readonly message: AgentMessage;
  readonly entryIndex: number | null;
}

/** The message projection used by both runtime context restoration and compaction. */
export interface SessionProjection {
  readonly messages: readonly SessionProjectedMessage[];
  readonly latestCompactionIndex: number | null;
}

/** Builds the current message projection for an active session branch. */
export function buildSessionMessageProjection(
  entries: readonly SessionEntry[],
): SessionProjection {
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
  if (firstKeptIndex < 0 || firstKeptIndex >= latestCompactionIndex) {
    throw new Error(
      `Compaction firstKeptEntryId is not an earlier branch entry: ${compaction.firstKeptEntryId}`,
    );
  }
  if (entries[firstKeptIndex].type === 'compaction') {
    throw new Error(
      `Compaction firstKeptEntryId cannot point to another compaction: ${compaction.firstKeptEntryId}`,
    );
  }

  const messages: SessionProjectedMessage[] = [
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
