import type { Turn, TurnEvent } from '@opspilot/domain';

/** Application persistence boundary for Turn aggregates and durable events. */
export interface TurnStore {
  /** Publishes a new Turn snapshot. */
  create(turn: Turn): void;

  /** Loads one Turn or raises an adapter-specific not-found error. */
  load(turnId: string): Turn;

  /** Replaces the current Turn snapshot. */
  save(turn: Turn): void;

  /** Appends one durable event without rewriting existing event history. */
  appendEvent(turnId: string, event: TurnEvent): void;

  /** Loads durable Turn events in sequence order. */
  loadEvents(turnId: string): readonly TurnEvent[];

  /** Lists Turn snapshots belonging to one Session. */
  listBySession(sessionId: string): readonly Turn[];

  /** Lists Turns that may require recovery inspection. */
  listRecoverable(): readonly Turn[];
}
