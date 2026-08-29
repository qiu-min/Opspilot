import type { SessionManager } from '../session/session-manager.js';

/** Application boundary for creating and loading sessions by session id. */
export interface SessionStore {
  create(): SessionManager;
  load(sessionId: string): SessionManager;
}
