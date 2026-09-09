/** Raised when a Turn filesystem layout is missing or corrupted. */
export class TurnStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TurnStoreError';
  }
}
