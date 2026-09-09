import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  Turn,
  type TurnCheckpoint,
  type TurnState,
  type TurnStatus,
  validateTurnCheckpoint,
} from '@opspilot/domain';

/** Current version of the filesystem Turn metadata document. */
export const CURRENT_TURN_METADATA_VERSION = 1 as const;

/** Persistence-side versioned representation of a Turn snapshot. */
export interface TurnMetadataRecord extends TurnState {
  readonly version: typeof CURRENT_TURN_METADATA_VERSION;
}

/** Raised when metadata.json cannot be read or does not satisfy its schema. */
export class TurnMetadataPersistenceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TurnMetadataPersistenceError';
  }
}

/** Serializes a validated Turn snapshot into metadata.json content. */
export function serializeTurnMetadata(state: TurnState): string {
  try {
    Turn.restore(state);
  } catch (error) {
    throw new TurnMetadataPersistenceError('Turn metadata violates domain invariants.', {
      cause: error,
    });
  }
  const record: TurnMetadataRecord = {
    version: CURRENT_TURN_METADATA_VERSION,
    id: state.id,
    sessionId: state.sessionId,
    status: state.status,
    baseLeafId: state.baseLeafId,
    inputEntryId: state.inputEntryId,
    resultLeafId: state.resultLeafId,
    attempt: state.attempt,
    checkpoint: state.checkpoint,
    createdAt: state.createdAt,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
  };
  validateTurnStateShape(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Parses metadata.json into a domain TurnState without unchecked shape casts. */
export function parseTurnMetadata(content: string): TurnState {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new TurnMetadataPersistenceError('metadata.json contains invalid JSON.', {
      cause: error,
    });
  }

  if (!isRecord(value)) {
    throw new TurnMetadataPersistenceError('metadata.json must contain a JSON object.');
  }
  if (value.version !== CURRENT_TURN_METADATA_VERSION) {
    throw new TurnMetadataPersistenceError(
      `metadata.json has unsupported version: ${String(value.version)}.`,
    );
  }

  const state: TurnState = {
    id: requireString(value.id, 'id'),
    sessionId: requireString(value.sessionId, 'sessionId'),
    status: requireTurnStatus(value.status),
    baseLeafId: requireNullableString(value.baseLeafId, 'baseLeafId'),
    inputEntryId: requireNullableString(value.inputEntryId, 'inputEntryId'),
    resultLeafId: requireNullableString(value.resultLeafId, 'resultLeafId'),
    attempt: requireNonNegativeInteger(value.attempt, 'attempt'),
    checkpoint: parseCheckpoint(value.checkpoint),
    createdAt: requireTimestamp(value.createdAt, 'createdAt'),
    startedAt: requireNullableTimestamp(value.startedAt, 'startedAt'),
    completedAt: requireNullableTimestamp(value.completedAt, 'completedAt'),
  };

  try {
    Turn.restore(state);
  } catch (error) {
    throw new TurnMetadataPersistenceError('metadata.json Turn state violates domain invariants.', {
      cause: error,
    });
  }
  return state;
}

/** Reads and validates one metadata.json document. */
export function loadTurnMetadata(filePath: string): TurnState {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new TurnMetadataPersistenceError(`Unable to read metadata.json: ${filePath}`, {
      cause: error,
    });
  }
  return parseTurnMetadata(content);
}

/** Writes a complete metadata document to a path in a newly created directory. */
export function writeTurnMetadataFile(filePath: string, state: TurnState): void {
  try {
    writeFileSync(filePath, serializeTurnMetadata(state), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new TurnMetadataPersistenceError(`Unable to write metadata.json: ${filePath}`, {
      cause: error,
    });
  }
}

/** Replaces metadata.json atomically through a temporary file and rename. */
export function rewriteTurnMetadataAtomically(filePath: string, state: TurnState): void {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    writeTurnMetadataFile(temporaryPath, state);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    throw new TurnMetadataPersistenceError(
      `Unable to atomically replace metadata.json: ${filePath}`,
      { cause: error },
    );
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original persistence error when cleanup also fails.
      }
    }
  }
}

function parseCheckpoint(value: unknown): TurnCheckpoint | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new TurnMetadataPersistenceError('metadata.json checkpoint must be null or an object.');
  }
  const checkpoint: TurnCheckpoint = {
    eventSequence: requireNonNegativeInteger(value.eventSequence, 'checkpoint.eventSequence'),
    sessionLeafId: requireNullableString(value.sessionLeafId, 'checkpoint.sessionLeafId'),
    phase: requireCheckpointPhase(value.phase),
  };
  try {
    validateTurnCheckpoint(checkpoint);
  } catch (error) {
    throw new TurnMetadataPersistenceError(
      error instanceof Error ? error.message : 'metadata.json checkpoint is invalid.',
      { cause: error },
    );
  }
  return checkpoint;
}

function validateTurnStateShape(record: TurnMetadataRecord): void {
  if (!isNonEmptyString(record.id)) throw new TurnMetadataPersistenceError('Turn id must be non-empty.');
  if (!isNonEmptyString(record.sessionId)) {
    throw new TurnMetadataPersistenceError('Turn sessionId must be non-empty.');
  }
  if (!isTurnStatus(record.status)) {
    throw new TurnMetadataPersistenceError(`Unsupported Turn status: ${String(record.status)}.`);
  }
  if (!Number.isInteger(record.attempt) || record.attempt < 0) {
    throw new TurnMetadataPersistenceError('Turn attempt must be a non-negative integer.');
  }
  if (!isTimestamp(record.createdAt)) {
    throw new TurnMetadataPersistenceError('Turn createdAt is invalid.');
  }
  if (record.startedAt !== null && !isTimestamp(record.startedAt)) {
    throw new TurnMetadataPersistenceError('Turn startedAt is invalid.');
  }
  if (record.completedAt !== null && !isTimestamp(record.completedAt)) {
    throw new TurnMetadataPersistenceError('Turn completedAt is invalid.');
  }
}

function requireString(value: unknown, field: string): string {
  if (!isNonEmptyString(value)) {
    throw new TurnMetadataPersistenceError(`metadata.json ${field} must be a non-empty string.`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireString(value, field);
}

function requireTimestamp(value: unknown, field: string): string {
  if (!isTimestamp(value)) {
    throw new TurnMetadataPersistenceError(`metadata.json ${field} must be a valid timestamp.`);
  }
  return value;
}

function requireNullableTimestamp(value: unknown, field: string): string | null {
  if (value === null) return null;
  return requireTimestamp(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new TurnMetadataPersistenceError(
      `metadata.json ${field} must be a non-negative integer.`,
    );
  }
  return value;
}

function requireTurnStatus(value: unknown): TurnStatus {
  if (!isTurnStatus(value)) {
    throw new TurnMetadataPersistenceError(`metadata.json status is invalid: ${String(value)}.`);
  }
  return value;
}

function requireCheckpointPhase(value: unknown): TurnCheckpoint['phase'] {
  if (
    value !== 'input_committed' &&
    value !== 'assistant_committed' &&
    value !== 'tool_completed'
  ) {
    throw new TurnMetadataPersistenceError(
      `metadata.json checkpoint.phase is invalid: ${String(value)}.`,
    );
  }
  return value;
}

function isTurnStatus(value: unknown): value is TurnStatus {
  return (
    value === 'pending' ||
    value === 'running' ||
    value === 'interrupted' ||
    value === 'completed' ||
    value === 'failed' ||
    value === 'cancelled'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}
