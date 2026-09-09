import { randomUUID } from 'node:crypto';

import {
  cloneTurnCheckpoint,
  type TurnCheckpoint,
  validateTurnCheckpoint,
} from './turn-checkpoint.js';
import { TurnStateError } from './turn-errors.js';

/** Statuses supported by the first Application Turn model. */
export type TurnStatus =
  | 'pending'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Durable state of one Application-level Turn. */
export interface TurnState {
  readonly id: string;
  readonly sessionId: string;
  readonly status: TurnStatus;
  readonly baseLeafId: string | null;
  readonly inputEntryId: string | null;
  readonly resultLeafId: string | null;
  readonly attempt: number;
  readonly checkpoint: TurnCheckpoint | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

/** Options for creating a new pending Turn. */
export interface TurnCreateOptions {
  readonly id?: string;
  readonly sessionId: string;
  readonly baseLeafId?: string | null;
  readonly createdAt?: string;
}

/** The Turn aggregate. Persistence and Agent execution remain outside Domain. */
export class Turn {
  private state: TurnState;

  private constructor(state: TurnState) {
    validateTurnState(state);
    this.state = cloneTurnState(state);
  }

  /** Creates a new pending Turn without starting execution. */
  public static create(options: TurnCreateOptions): Turn {
    const id = options.id ?? randomUUID();
    const createdAt = options.createdAt ?? new Date().toISOString();
    const state: TurnState = {
      id,
      sessionId: options.sessionId,
      status: 'pending',
      baseLeafId: options.baseLeafId ?? null,
      inputEntryId: null,
      resultLeafId: null,
      attempt: 0,
      checkpoint: null,
      createdAt,
      startedAt: null,
      completedAt: null,
    };
    return new Turn(state);
  }

  /** Restores a Turn and re-validates all domain invariants. */
  public static restore(state: TurnState): Turn {
    return new Turn(state);
  }

  /** Returns an immutable snapshot of the current durable Turn state. */
  public getState(): TurnState {
    return cloneTurnState(this.state);
  }

  /** Returns the stable Turn identifier. */
  public getId(): string {
    return this.state.id;
  }

  /** Returns the owning Session identifier. */
  public getSessionId(): string {
    return this.state.sessionId;
  }

  /** Starts a pending Turn and creates its first execution attempt. */
  public start(timestamp = new Date().toISOString()): void {
    this.assertStatus('pending', 'start');
    assertAtOrAfter(timestamp, this.state.createdAt, 'startedAt');
    this.state = {
      ...this.state,
      status: 'running',
      attempt: 1,
      startedAt: timestamp,
    };
  }

  /** Records the SessionEntry created for the user input. */
  public recordInput(inputEntryId: string): void {
    assertId(inputEntryId, 'inputEntryId');
    if (this.state.inputEntryId !== null) {
      if (this.state.inputEntryId === inputEntryId) return;
      throw new TurnStateError('Turn inputEntryId has already been recorded.');
    }
    if (this.state.status === 'completed' || this.state.status === 'failed' || this.state.status === 'cancelled') {
      throw new TurnStateError('Terminal Turn cannot record input.');
    }
    this.state = { ...this.state, inputEntryId };
  }

  /** Records the latest durable Session leaf reached by this Turn. */
  public recordResultLeaf(resultLeafId: string | null): void {
    if (isTerminalStatus(this.state.status)) {
      throw new TurnStateError('Terminal Turn cannot record a result leaf.');
    }
    assertNullableId(resultLeafId, 'resultLeafId');
    this.state = { ...this.state, resultLeafId };
  }

  /** Advances the latest safe durable recovery point. */
  public advanceCheckpoint(checkpoint: TurnCheckpoint): void {
    if (isTerminalStatus(this.state.status)) {
      throw new TurnStateError('Terminal Turn cannot advance its checkpoint.');
    }
    validateTurnCheckpoint(checkpoint);
    if (
      this.state.checkpoint !== null &&
      checkpoint.eventSequence <= this.state.checkpoint.eventSequence
    ) {
      throw new TurnStateError(
        'Turn checkpoint eventSequence must be greater than the previous checkpoint.',
      );
    }
    this.state = { ...this.state, checkpoint: cloneTurnCheckpoint(checkpoint) };
  }

  /** Marks a running Turn as interrupted without making it terminal. */
  public markInterrupted(timestamp = new Date().toISOString()): void {
    this.assertStatus('running', 'markInterrupted');
    this.assertStartedTimestamp(timestamp, 'interruptedAt');
    this.state = { ...this.state, status: 'interrupted' };
  }

  /** Resumes an interrupted Turn as a new attempt with the same identity. */
  public resume(timestamp = new Date().toISOString()): void {
    this.assertStatus('interrupted', 'resume');
    this.assertStartedTimestamp(timestamp, 'resumeAt');
    this.state = {
      ...this.state,
      status: 'running',
      attempt: this.state.attempt + 1,
    };
  }

  /** Reconciles a durable terminal event that was appended before the snapshot save. */
  public reconcileTerminal(
    status: Extract<TurnStatus, 'completed' | 'failed' | 'cancelled'>,
    resultLeafId: string | null = this.state.resultLeafId,
    timestamp = new Date().toISOString(),
  ): void {
    if (this.state.status !== 'running' && this.state.status !== 'interrupted') {
      if (this.state.status === status) return;
      throw new TurnStateError(
        `Cannot reconcile terminal Turn in status ${this.state.status}.`,
      );
    }
    assertNullableId(resultLeafId, 'resultLeafId');
    this.assertStartedTimestamp(timestamp, 'completedAt');
    this.state = {
      ...this.state,
      status,
      resultLeafId: status === 'completed' ? resultLeafId : this.state.resultLeafId,
      completedAt: timestamp,
    };
  }

  /** Completes a running Turn and optionally records its final Session leaf. */
  public complete(resultLeafId: string | null = this.state.resultLeafId, timestamp = new Date().toISOString()): void {
    this.assertStatus('running', 'complete');
    assertNullableId(resultLeafId, 'resultLeafId');
    this.assertStartedTimestamp(timestamp, 'completedAt');
    this.state = {
      ...this.state,
      status: 'completed',
      resultLeafId,
      completedAt: timestamp,
    };
  }

  /** Fails a running Turn and records its terminal timestamp. */
  public fail(timestamp = new Date().toISOString()): void {
    this.assertStatus('running', 'fail');
    this.assertStartedTimestamp(timestamp, 'completedAt');
    this.state = { ...this.state, status: 'failed', completedAt: timestamp };
  }

  /** Cancels a running Turn and records its terminal timestamp. */
  public cancel(timestamp = new Date().toISOString()): void {
    this.assertStatus('running', 'cancel');
    this.assertStartedTimestamp(timestamp, 'completedAt');
    this.state = { ...this.state, status: 'cancelled', completedAt: timestamp };
  }

  private assertStatus(expected: TurnStatus, operation: string): void {
    if (this.state.status !== expected) {
      throw new TurnStateError(
        `Cannot ${operation} Turn in status ${this.state.status}; expected ${expected}.`,
      );
    }
  }

  private assertStartedTimestamp(timestamp: string, field: string): void {
    if (this.state.startedAt === null) {
      throw new TurnStateError(`Turn ${field} requires a startedAt timestamp.`);
    }
    assertAtOrAfter(timestamp, this.state.startedAt, field);
  }
}

/** Validates a restored Turn snapshot. */
function validateTurnState(state: TurnState): void {
  if (!isRecord(state)) throw new TurnStateError('Turn state must be an object.');
  assertId(state.id, 'Turn id');
  assertId(state.sessionId, 'Turn sessionId');
  if (!isTurnStatus(state.status)) throw new TurnStateError(`Unsupported Turn status: ${String(state.status)}.`);
  assertNullableId(state.baseLeafId, 'Turn baseLeafId');
  assertNullableId(state.inputEntryId, 'Turn inputEntryId');
  assertNullableId(state.resultLeafId, 'Turn resultLeafId');
  if (!Number.isInteger(state.attempt) || state.attempt < 0) {
    throw new TurnStateError('Turn attempt must be a non-negative integer.');
  }
  if (state.checkpoint !== null) validateTurnCheckpoint(state.checkpoint);
  assertTimestamp(state.createdAt, 'Turn createdAt');
  assertNullableTimestamp(state.startedAt, 'Turn startedAt');
  assertNullableTimestamp(state.completedAt, 'Turn completedAt');

  const created = Date.parse(state.createdAt);
  const started = state.startedAt === null ? undefined : Date.parse(state.startedAt);
  const completed = state.completedAt === null ? undefined : Date.parse(state.completedAt);
  if (started !== undefined && started < created) {
    throw new TurnStateError('Turn startedAt cannot be earlier than createdAt.');
  }
  if (completed !== undefined && started === undefined) {
    throw new TurnStateError('Turn completedAt requires startedAt.');
  }
  if (completed !== undefined && completed < started!) {
    throw new TurnStateError('Turn completedAt cannot be earlier than startedAt.');
  }
  if (state.completedAt !== null && !isTerminalStatus(state.status)) {
    throw new TurnStateError('Turn completedAt is only allowed for terminal status.');
  }
  if (isTerminalStatus(state.status) && state.completedAt === null) {
    throw new TurnStateError('Terminal Turn requires completedAt.');
  }
  if (state.status === 'pending') {
    if (state.attempt !== 0 || state.startedAt !== null || state.completedAt !== null) {
      throw new TurnStateError('Pending Turn must not have started execution.');
    }
  } else if (state.attempt < 1 || state.startedAt === null) {
    throw new TurnStateError('Started, interrupted, and terminal Turns require attempt and startedAt.');
  }
}

function cloneTurnState(state: TurnState): TurnState {
  return {
    ...state,
    checkpoint: state.checkpoint === null ? null : cloneTurnCheckpoint(state.checkpoint),
  };
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

function isTerminalStatus(status: TurnStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TurnStateError(`${field} must be a non-empty string.`);
  }
}

function assertNullableId(value: unknown, field: string): void {
  if (value !== null) assertId(value, field);
}

function assertTimestamp(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new TurnStateError(`${field} must be a valid timestamp.`);
  }
}

function assertNullableTimestamp(value: unknown, field: string): void {
  if (value !== null) assertTimestamp(value, field);
}

function assertAtOrAfter(value: string, previous: string, field: string): void {
  assertTimestamp(value, field);
  if (Date.parse(value) < Date.parse(previous)) {
    throw new TurnStateError(`${field} cannot be earlier than ${previous}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
