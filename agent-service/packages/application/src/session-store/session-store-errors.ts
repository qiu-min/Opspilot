/** Raised when a Session filesystem layout is missing or corrupted. */
export class SessionStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionStoreError';
  }
}
