import { Session, type SessionEntry, type SessionMetadata } from '@opspilot/domain';

import type { SessionStore } from '../../src/session-store/session-store.js';

interface SessionRecord {
  readonly header: ReturnType<Session['getHeader']>;
  metadata: SessionMetadata;
  readonly entries: SessionEntry[];
}

/** Test-only SessionStore fake for application unit tests. */
export class InMemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  public create(): Session {
    const session = Session.create();
    this.records.set(session.getId(), {
      header: session.getHeader(),
      metadata: session.getMetadata(),
      entries: [],
    });
    return session;
  }

  public load(sessionId: string): Session {
    const record = this.require(sessionId);
    return Session.restore({
      metadata: structuredClone(record.metadata),
      header: structuredClone(record.header),
      entries: structuredClone(record.entries),
    });
  }

  public appendEntry(sessionId: string, entry: SessionEntry): void {
    const record = this.require(sessionId);
    record.entries.push(structuredClone(entry));
    if (Date.parse(entry.timestamp) > Date.parse(record.metadata.updatedAt)) {
      record.metadata = { ...record.metadata, updatedAt: entry.timestamp };
    }
  }

  public saveMetadata(sessionId: string, metadata: SessionMetadata): void {
    const record = this.require(sessionId);
    if (metadata.id !== sessionId) {
      throw new Error(`Session metadata id does not match session id: ${metadata.id}`);
    }
    record.metadata = structuredClone(metadata);
  }

  private require(sessionId: string): SessionRecord {
    const record = this.records.get(sessionId);
    if (record === undefined) throw new Error(`Session not found: ${sessionId}`);
    return record;
  }
}
