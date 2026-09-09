import type { TurnStreamEvent, TurnStreamEventDraft } from './turn-stream-event.js';
import type { TurnStreamProjection } from './turn-stream-projection.js';

export interface OpenTurnStreamInput {
  readonly turnId: string;
  readonly sessionId: string;
}

export interface ActiveTurnStreamSnapshot {
  readonly turnId: string;
  readonly sessionId: string;
  readonly status: 'running';
  readonly projection: TurnStreamProjection;
}

/** Application port for ephemeral Turn UI delivery and replay. */
export interface TurnStreamHub {
  openTurn(input: OpenTurnStreamInput): void;
  publish(event: TurnStreamEventDraft): TurnStreamEvent;
  publishDraft(event: TurnStreamEventDraft): TurnStreamEvent;
  getActiveTurn(sessionId: string): ActiveTurnStreamSnapshot | null;
  getProjection(turnId: string): TurnStreamProjection | null;
  subscribe(turnId: string, afterSequence?: number): AsyncIterable<TurnStreamEvent>;
  closeTurn(turnId: string): void;
}

/** Raised when a requested replay point has fallen out of the finite ring buffer. */
export class TurnStreamReplayGapError extends Error {
  public readonly code = 'TURN_STREAM_REPLAY_GAP';

  public constructor(
    public readonly requestedAfter: number,
    public readonly oldestAvailable: number,
    public readonly latestAvailable: number,
  ) {
    super(
      `Turn stream replay gap: requested after ${requestedAfter}, ` +
        `oldest available ${oldestAvailable}, latest available ${latestAvailable}.`,
    );
    this.name = 'TurnStreamReplayGapError';
  }
}

/** Raised when an HTTP client asks to attach to a Turn channel that is not live. */
export class TurnStreamNotFoundError extends Error {
  public readonly code = 'TURN_STREAM_NOT_FOUND';

  public constructor(public readonly turnId: string) {
    super(`Turn ${turnId} is not currently available for stream reattachment.`);
    this.name = 'TurnStreamNotFoundError';
  }
}

/** Raised when two live executions try to own the same Session. */
export class TurnStreamSessionConflictError extends Error {
  public readonly code = 'SESSION_ACTIVE_TURN_CONFLICT';

  public constructor(
    public readonly sessionId: string,
    public readonly activeTurnId: string,
  ) {
    super(`Session ${sessionId} already has active Turn ${activeTurnId}.`);
    this.name = 'TurnStreamSessionConflictError';
  }
}
