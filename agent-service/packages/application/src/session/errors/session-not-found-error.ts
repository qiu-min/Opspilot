/** Raised when durable Session state is absent. */
export class SessionNotFoundError extends Error {
  public readonly sessionId: string;

  public constructor(sessionId: string) {
    super(`Session file does not exist for Session ${sessionId}.`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}
