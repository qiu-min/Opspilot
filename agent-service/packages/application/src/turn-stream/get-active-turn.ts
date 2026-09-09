import type { ActiveTurnStreamSnapshot, TurnStreamHub } from './turn-stream-hub.js';

/** Application query for the currently live execution owned by a Session. */
export class GetActiveTurn {
  public constructor(private readonly turnStreamHub: TurnStreamHub) {}

  /** Returns the current process-local active Turn owned by the Session, if any. */
  public execute(sessionId: string): ActiveTurnStreamSnapshot | null {
    return this.turnStreamHub.getActiveTurn(sessionId);
  }
}
