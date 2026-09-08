/** Raised when a requested Session entry does not exist. */
export class SessionEntryNotFoundError extends Error {
  public constructor(entryId: string) {
    super(`Session entry not found: ${entryId}`);
    this.name = 'SessionEntryNotFoundError';
  }
}

/** Raised when Session tree or aggregate invariants are violated. */
export class SessionTreeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SessionTreeError';
  }
}

/** Raised when Session product metadata violates its domain invariants. */
export class SessionMetadataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SessionMetadataError';
  }
}
