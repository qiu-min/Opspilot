/** Base error for invalid Turn domain operations or state. */
export class TurnError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TurnError';
  }
}

/** Raised when a Turn status transition is not allowed. */
export class TurnStateError extends TurnError {
  public constructor(message: string) {
    super(message);
    this.name = 'TurnStateError';
  }
}

/** Raised when a Turn checkpoint violates its value-object invariants. */
export class TurnCheckpointError extends TurnError {
  public constructor(message: string) {
    super(message);
    this.name = 'TurnCheckpointError';
  }
}

/** Raised when a durable TurnEvent is malformed. */
export class TurnEventError extends TurnError {
  public constructor(message: string) {
    super(message);
    this.name = 'TurnEventError';
  }
}
