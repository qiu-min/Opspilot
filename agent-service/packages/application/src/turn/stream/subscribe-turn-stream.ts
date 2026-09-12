import type { TurnStreamEvent } from './turn-stream-event.js';
import type { TurnStreamHub } from './turn-stream-hub.js';

/** Application use case for attaching to an already-running Turn. */
export class SubscribeTurnStream {
  public constructor(private readonly turnStreamHub: TurnStreamHub) {}

  /** Attaches to an existing channel without creating or starting a Turn. */
  public execute(turnId: string, afterSequence?: number): AsyncIterable<TurnStreamEvent> {
    return this.turnStreamHub.subscribe(turnId, afterSequence);
  }
}
