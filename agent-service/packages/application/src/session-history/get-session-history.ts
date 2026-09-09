import type { SessionStore } from '../session-store/session-store.js';
import {
  buildSessionHistoryProjection,
  type SessionHistoryProjection,
} from './session-history-projection.js';

/** Reads the active branch history for an existing Agent Service session. */
export class GetSessionHistory {
  private readonly sessionStore: SessionStore;

  public constructor(sessionStore: SessionStore) {
    this.sessionStore = sessionStore;
  }

  /** Loads an existing session without creating one and projects its UI-safe history. */
  public execute(sessionId: string): SessionHistoryProjection {
    const session = this.sessionStore.load(sessionId);
    return buildSessionHistoryProjection(session.getBranch(), session.getLeafId());
  }
}
