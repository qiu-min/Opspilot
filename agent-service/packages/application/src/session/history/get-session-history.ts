import type { SessionStore } from '../ports/session-store.js';
import type { TurnStore } from '../../turn/ports/turn-store.js';
import type { ToolPresentationResolver } from '../../turn/presentation/tool-presentation.js';
import {
  buildTurnPresentationSummary,
  type TurnPresentationSummary,
} from '../../turn/presentation/index.js';
import {
  buildSessionHistoryProjection,
  type SessionHistoryProjection,
} from './session-history-projection.js';

export interface GetSessionHistoryDependencies {
  readonly sessionStore: SessionStore;
  readonly turnStore: TurnStore;
  readonly toolPresentationResolver?: ToolPresentationResolver;
}

export interface SessionHistoryResult extends SessionHistoryProjection {
  readonly turnSummaries: readonly TurnPresentationSummary[];
}

/** Reads the active branch history for an existing Agent Service session. */
export class GetSessionHistory {
  private readonly sessionStore: SessionStore;
  private readonly turnStore: TurnStore;
  private readonly toolPresentationResolver?: ToolPresentationResolver;

  public constructor(dependencies: GetSessionHistoryDependencies) {
    this.sessionStore = dependencies.sessionStore;
    this.turnStore = dependencies.turnStore;
    this.toolPresentationResolver = dependencies.toolPresentationResolver;
  }

  /** Loads an existing session without creating one and projects its UI-safe history. */
  public execute(sessionId: string): SessionHistoryResult {
    const session = this.sessionStore.load(sessionId);
    const branch = session.getBranch();
    const history = buildSessionHistoryProjection(branch, session.getLeafId());
    const branchEntryIds = new Set(branch.map((entry) => entry.id));
    const branchEntryOrder = new Map(branch.map((entry, index) => [entry.id, index] as const));
    const turnSummaries = this.turnStore
      .listBySession(sessionId)
      .filter((turn) => {
        const inputEntryId = turn.getState().inputEntryId;
        return inputEntryId !== null && branchEntryIds.has(inputEntryId);
      })
      .map((turn) =>
        buildTurnPresentationSummary({
          turn,
          events: this.turnStore.loadEvents(turn.getId()),
          session,
          toolPresentationResolver: this.toolPresentationResolver,
        }),
      )
      .filter((summary): summary is TurnPresentationSummary => summary !== undefined)
      .sort(
        (left, right) =>
          (branchEntryOrder.get(left.inputEntryId) ?? Number.MAX_SAFE_INTEGER) -
          (branchEntryOrder.get(right.inputEntryId) ?? Number.MAX_SAFE_INTEGER),
      );

    return { ...history, turnSummaries };
  }
}
