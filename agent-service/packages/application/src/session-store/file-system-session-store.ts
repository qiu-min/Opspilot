import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { SessionManager } from '../session/session-manager.js';
import type { SessionStore } from './session-store.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Stores SessionManager JSONL files under a single filesystem directory. */
export class FileSystemSessionStore implements SessionStore {
  private readonly baseDirectory: string;

  public constructor(baseDirectory: string) {
    this.baseDirectory = baseDirectory;
  }

  /** Creates a persisted session whose header id matches its filename. */
  public create(): SessionManager {
    const sessionId = randomUUID();
    return SessionManager.createPersisted(this.getSessionFilePath(sessionId), { id: sessionId });
  }

  /** Loads a persisted session after validating both its id and stored header. */
  public load(sessionId: string): SessionManager {
    this.assertValidSessionId(sessionId);
    const sessionManager = SessionManager.load(this.getSessionFilePath(sessionId));
    const storedSessionId = sessionManager.getHeader().id;

    if (storedSessionId !== sessionId) {
      throw new Error(
        `Session header id does not match requested sessionId: ${storedSessionId} !== ${sessionId}.`,
      );
    }

    return sessionManager;
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
