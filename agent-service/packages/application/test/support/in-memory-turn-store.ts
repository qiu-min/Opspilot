import { Turn, type TurnEvent } from '@opspilot/domain';

import type { TurnStore } from '../../src/turn-store/turn-store.js';

/** In-memory TurnStore used by application tests to exercise persistence ordering. */
export class InMemoryTurnStore implements TurnStore {
  private readonly turns = new Map<string, Turn>();
  private readonly events = new Map<string, TurnEvent[]>();

  public create(turn: Turn): void {
    if (this.turns.has(turn.getId())) throw new Error(`Turn already exists: ${turn.getId()}`);
    this.turns.set(turn.getId(), Turn.restore(turn.getState()));
    this.events.set(turn.getId(), []);
  }

  public load(turnId: string): Turn {
    const turn = this.turns.get(turnId);
    if (turn === undefined) throw new Error(`Turn not found: ${turnId}`);
    return Turn.restore(turn.getState());
  }

  public save(turn: Turn): void {
    if (!this.turns.has(turn.getId())) throw new Error(`Turn not found: ${turn.getId()}`);
    this.turns.set(turn.getId(), Turn.restore(turn.getState()));
  }

  public appendEvent(turnId: string, event: TurnEvent): void {
    const events = this.events.get(turnId);
    if (events === undefined) throw new Error(`Turn not found: ${turnId}`);
    if (event.sequence !== events.length) {
      throw new Error(`Expected event sequence ${events.length}, received ${event.sequence}`);
    }
    events.push(structuredClone(event));
  }

  public loadEvents(turnId: string): readonly TurnEvent[] {
    const events = this.events.get(turnId);
    if (events === undefined) throw new Error(`Turn not found: ${turnId}`);
    return structuredClone(events);
  }

  public listBySession(sessionId: string): readonly Turn[] {
    return [...this.turns.values()]
      .filter((turn) => turn.getSessionId() === sessionId)
      .map((turn) => Turn.restore(turn.getState()));
  }

  public listRecoverable(): readonly Turn[] {
    return [...this.turns.values()]
      .filter((turn) => ['running', 'interrupted'].includes(turn.getState().status))
      .map((turn) => Turn.restore(turn.getState()));
  }
}
