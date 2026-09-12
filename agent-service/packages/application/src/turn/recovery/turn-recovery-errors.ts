/** Raised when persisted recovery inputs cannot be interpreted safely. */
export class TurnRecoveryError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TurnRecoveryError';
  }
}
