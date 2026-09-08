import type { SessionStore } from '../session-store/session-store.js';
import {
  buildConversationHistoryProjection,
  type ConversationHistoryProjection,
} from './conversation-history-projection.js';

/** Reads the active branch history for an existing Agent Service session. */
export class GetConversationHistory {
  private readonly sessionStore: SessionStore;

  public constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  /** Loads an existing session without creating one and projects its UI-safe history. */
  public execute(sessionId: string): ConversationHistoryProjection {
    const session = this.sessionStore.load(sessionId);
    return buildConversationHistoryProjection(session.getBranch(), session.getLeafId());
  }
}
