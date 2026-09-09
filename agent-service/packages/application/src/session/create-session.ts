import type { SessionStore } from '../session-store/session-store.js';

/** Result of creating an empty durable Agent Service Session. */
export interface CreateSessionResult {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Creates only the durable Session aggregate; no Turn or model execution is started. */
export class CreateSession {
  public constructor(private readonly sessionStore: SessionStore) {}

  public execute(): CreateSessionResult {
    const metadata = this.sessionStore.create().getMetadata();
    return {
      sessionId: metadata.id,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    };
  }
}
