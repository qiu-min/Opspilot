import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { Session, type SessionEntry } from '@opspilot/domain';

import { appendSessionEntry, createSessionFile, loadSessionFile } from './session-jsonl.js';
import type { SessionStore } from './session-store.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Stores Session aggregates as append-only JSONL files under one directory. */
export class FileSystemSessionStore implements SessionStore {
  private readonly baseDirectory: string;

  public constructor(baseDirectory: string) {
    this.baseDirectory = baseDirectory;
  }

  /** Creates a persisted session whose header id matches its filename. */
  public create(): Session {
    const sessionId = randomUUID();
    const session = Session.create({ id: sessionId });
    createSessionFile(this.getSessionFilePath(sessionId), session.getHeader());
    return session;
  }

  /** Loads a persisted session after validating both its id and stored header. */
  public load(sessionId: string): Session {
    this.assertValidSessionId(sessionId);
    const loaded = loadSessionFile(this.getSessionFilePath(sessionId));
    const storedSessionId = loaded.header.id;

    if (storedSessionId !== sessionId) {
      throw new Error(
        `Session header id does not match requested sessionId: ${storedSessionId} !== ${sessionId}.`,
      );
    }

    return Session.restore(loaded.header, loaded.entries);
  }

  /** Persists one domain mutation without coupling the domain to JSONL. */
  public appendEntry(sessionId: string, entry: SessionEntry): void {
    this.assertValidSessionId(sessionId);
    appendSessionEntry(this.getSessionFilePath(sessionId), entry);
  }

  private getSessionFilePath(sessionId: string): string {
    this.assertValidSessionId(sessionId);
    return join(this.baseDirectory, `${sessionId}.jsonl`);
  }

  private assertValidSessionId(sessionId: string): void {
    if (typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)) {
      throw new Error(`Invalid sessionId: ${sessionId}.`);
    }
  }
}
