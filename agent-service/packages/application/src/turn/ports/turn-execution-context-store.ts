import type { TurnExecutionContext } from '../execution/turn-execution-context.js';

/** Persistence boundary for Turn inputs that are not part of the Domain Turn. */
export interface TurnExecutionContextStore {
  save(turnId: string, context: TurnExecutionContext): void;
  load(turnId: string): TurnExecutionContext | null;
}
