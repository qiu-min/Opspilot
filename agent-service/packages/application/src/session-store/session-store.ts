import type { Session, SessionEntry } from '@opspilot/domain';

/** Application persistence boundary for Session aggregates. */
export interface SessionStore {
  create(): Session;
  load(sessionId: string): Session;
  appendEntry(sessionId: string, entry: SessionEntry): void;
}
