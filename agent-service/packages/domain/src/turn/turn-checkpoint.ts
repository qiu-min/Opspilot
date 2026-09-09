import { TurnCheckpointError } from './turn-errors.js';

/** Safe durable boundary used to locate a future Turn resume point. */
export interface TurnCheckpoint {
  readonly eventSequence: number;
  readonly sessionLeafId: string | null;
  readonly phase: TurnCheckpointPhase;
}

/** Recovery phases supported by the first Turn model version. */
export type TurnCheckpointPhase =
  | 'input_committed'
  | 'model_completed'
  | 'tool_completed';

/** Validates and clones a checkpoint without retaining mutable caller state. */
export function cloneTurnCheckpoint(checkpoint: TurnCheckpoint): TurnCheckpoint {
  validateTurnCheckpoint(checkpoint);
  return { ...checkpoint };
}

/** Validates the checkpoint value-object invariants. */
export function validateTurnCheckpoint(checkpoint: TurnCheckpoint): void {
  if (!isRecord(checkpoint)) {
    throw new TurnCheckpointError('Turn checkpoint must be an object.');
  }
  if (!Number.isInteger(checkpoint.eventSequence) || checkpoint.eventSequence < 0) {
    throw new TurnCheckpointError(
      'Turn checkpoint eventSequence must be a non-negative integer.',
    );
  }
  if (checkpoint.sessionLeafId !== null && !isNonEmptyString(checkpoint.sessionLeafId)) {
    throw new TurnCheckpointError(
      'Turn checkpoint sessionLeafId must be null or a non-empty string.',
    );
  }
  if (!isTurnCheckpointPhase(checkpoint.phase)) {
    throw new TurnCheckpointError(
      `Unsupported Turn checkpoint phase: ${String(checkpoint.phase)}.`,
    );
  }
}

/** Checks whether a value is a supported checkpoint phase. */
export function isTurnCheckpointPhase(value: unknown): value is TurnCheckpointPhase {
  return (
    value === 'input_committed' || value === 'model_completed' || value === 'tool_completed'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
