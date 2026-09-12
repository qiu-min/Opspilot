/** Raised when a Session still has an interrupted execution that must be recovered first. */
export class SessionRecoverableTurnConflictError extends Error {
  public readonly code = 'SESSION_RECOVERABLE_TURN_EXISTS';

  public constructor(
    public readonly sessionId: string,
    public readonly turnId: string,
  ) {
    super(`Session ${sessionId} has recoverable Turn ${turnId}.`);
    this.name = 'SessionRecoverableTurnConflictError';
  }
}
