import type { TurnState } from '@opspilot/domain';
import { projectTurnTrace, type TurnTrace } from '@opspilot/observability';

import type { TurnStore } from '../ports/turn-store.js';

export interface GetTurnTraceDependencies {
  readonly turnStore: TurnStore;
}

/** Reads one durable Turn history and projects it into the logical TurnTrace read model. */
export class GetTurnTrace {
  private readonly turnStore: TurnStore;

  public constructor(dependencies: GetTurnTraceDependencies) {
    this.turnStore = dependencies.turnStore;
  }

  /** Loads the Turn before its events so absence cannot be mistaken for an empty history. */
  public execute(turnId: string): TurnTrace {
    const turn = this.turnStore.load(turnId);
    const events = this.turnStore.loadEvents(turnId);
    if (events.length > 0) return projectTurnTrace(events);

    return createEmptyTurnTrace(turn.getState());
  }
}

/** Supplies a deterministic identity/status response for a valid Turn with no events yet. */
function createEmptyTurnTrace(state: TurnState): TurnTrace {
  return {
    turnId: state.id,
    sessionId: state.sessionId,
    status: mapTurnStatus(state.status),
    startedAt: state.startedAt,
    endedAt: state.completedAt,
    durationMs: calculateDuration(state.startedAt, state.completedAt),
    spans: [],
  };
}

/** Maps the durable aggregate status to the smaller Trace status vocabulary. */
function mapTurnStatus(status: TurnState['status']): TurnTrace['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
    case 'running':
    case 'interrupted':
      return 'running';
  }
}

/** Calculates metadata duration without consulting the system clock. */
function calculateDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  return Number.isFinite(startedMs) && Number.isFinite(endedMs) && endedMs >= startedMs
    ? endedMs - startedMs
    : null;
}
