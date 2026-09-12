/** Raised when a requested Turn durable state does not exist. */
export class TurnNotFoundError extends Error {
  public constructor(public readonly turnId: string) {
    super(`Turn not found: ${turnId}`);
    this.name = 'TurnNotFoundError';
  }
}
