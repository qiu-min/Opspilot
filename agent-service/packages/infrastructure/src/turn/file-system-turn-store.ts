import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import type { TurnStore } from '@opspilot/application';
import {
  Turn,
  type TurnEvent,
  type TurnState,
  type TurnStatus,
  validateTurnEvent,
} from '@opspilot/domain';

import {
  loadTurnMetadata,
  rewriteTurnMetadataAtomically,
  writeTurnMetadataFile,
} from './turn-metadata-json.js';
import {
  appendTurnEvent,
  createTurnEventsFile,
  loadTurnEvents,
  TurnEventsJsonlError,
} from './turn-events-jsonl.js';
import { TurnStoreError } from './turn-store-errors.js';

interface TurnPaths {
  readonly directory: string;
  readonly metadata: string;
  readonly events: string;
}

/** Stores Turn snapshots and append-only events under storageRoot/turns. */
export class FileSystemTurnStore implements TurnStore {
  private readonly turnsDirectory: string;

  public constructor(storageRoot: string) {
    this.turnsDirectory = join(storageRoot, 'turns');
  }

  /** Creates and atomically publishes a complete Turn directory. */
  public create(turn: Turn): void {
    const state = turn.getState();
    const paths = this.getTurnPaths(state.id);
    const temporaryDirectory = this.createTemporaryDirectory(state.id);

    try {
      writeTurnMetadataFile(join(temporaryDirectory, 'metadata.json'), state);
      createTurnEventsFile(join(temporaryDirectory, 'events.jsonl'));
      this.validateEventLog(state.id, state, []);
      if (existsSync(paths.directory)) {
        throw new TurnStoreError(`Turn already exists: ${state.id}.`);
      }
      renameSync(temporaryDirectory, paths.directory);
    } catch (error) {
      this.removeTemporaryDirectory(temporaryDirectory);
      if (error instanceof TurnStoreError) throw error;
      throw new TurnStoreError(`Unable to create Turn ${state.id}.`, { cause: error });
    }
  }

  /** Loads and validates one Turn snapshot and its event log. */
  public load(turnId: string): Turn {
    const paths = this.getTurnPaths(turnId);
    this.assertCompleteLayout(turnId, paths);
    const state = this.loadState(paths);
    this.validateEventLog(turnId, state, this.readEvents(paths));
    try {
      return Turn.restore(state);
    } catch (error) {
      throw new TurnStoreError(`Turn metadata violates domain invariants: ${turnId}.`, {
        cause: error,
      });
    }
  }

  /** Atomically replaces the current Turn metadata snapshot. */
  public save(turn: Turn): void {
    const state = turn.getState();
    const paths = this.getTurnPaths(state.id);
    this.assertCompleteLayout(state.id, paths);
    this.validateEventLog(state.id, state, this.readEvents(paths));
    rewriteTurnMetadataAtomically(paths.metadata, state);
  }

  /** Appends one event after validating its identity, attempt, and next sequence. */
  public appendEvent(turnId: string, event: TurnEvent): void {
    const paths = this.getTurnPaths(turnId);
    this.assertCompleteLayout(turnId, paths);
    const state = this.loadState(paths);
    const events = this.readEvents(paths);

    try {
      validateTurnEvent(event);
    } catch (error) {
      throw new TurnStoreError(`Invalid TurnEvent for Turn ${turnId}.`, { cause: error });
    }
    if (event.turnId !== turnId) {
      throw new TurnStoreError(`TurnEvent turnId does not match requested Turn: ${event.turnId}.`);
    }
    if (event.sessionId !== state.sessionId) {
      throw new TurnStoreError(
        `TurnEvent sessionId does not match Turn ${turnId}: ${event.sessionId} !== ${state.sessionId}.`,
      );
    }
    if (event.attempt !== state.attempt) {
      throw new TurnStoreError(
        `TurnEvent attempt does not match Turn ${turnId}: ${event.attempt} !== ${state.attempt}.`,
      );
    }
    const expectedSequence = events.length;
    if (event.sequence !== expectedSequence) {
      throw new TurnStoreError(
        `TurnEvent sequence must be ${expectedSequence} for Turn ${turnId}, received ${event.sequence}.`,
      );
    }
    if (events.some((existing) => existing.id === event.id)) {
      throw new TurnStoreError(`Duplicate TurnEvent id for Turn ${turnId}: ${event.id}.`);
    }

    try {
      appendTurnEvent(paths.events, event);
    } catch (error) {
      if (error instanceof TurnEventsJsonlError) {
        throw new TurnStoreError(`Unable to append TurnEvent for Turn ${turnId}.`, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /** Loads one Turn's events in strict sequence order. */
  public loadEvents(turnId: string): readonly TurnEvent[] {
    const paths = this.getTurnPaths(turnId);
    this.assertCompleteLayout(turnId, paths);
    const state = this.loadState(paths);
    return this.validateEventLog(turnId, state, this.readEvents(paths));
  }

  /** Lists Turns for one Session in deterministic creation order. */
  public listBySession(sessionId: string): readonly Turn[] {
    assertNonEmptyId(sessionId, 'sessionId');
    return this.listTurns().filter((turn) => turn.getSessionId() === sessionId);
  }

  /** Lists running or interrupted Turns that may require recovery inspection. */
  public listRecoverable(): readonly Turn[] {
    return this.listTurns().filter((turn) => {
      const status = turn.getState().status;
      return status === 'running' || status === 'interrupted';
    });
  }

  private listTurns(): Turn[] {
    if (!existsSync(this.turnsDirectory)) return [];
    const entries = readdirSync(this.turnsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
      .map((entry) => this.load(entry.name));
    return entries.sort((left, right) => {
      const timestampOrder = Date.parse(left.getState().createdAt) - Date.parse(right.getState().createdAt);
      return timestampOrder !== 0 ? timestampOrder : left.getId().localeCompare(right.getId());
    });
  }

  private loadState(paths: TurnPaths): TurnState {
    try {
      return loadTurnMetadata(paths.metadata);
    } catch (error) {
      throw new TurnStoreError(`Unable to load Turn metadata: ${paths.metadata}.`, { cause: error });
    }
  }

  private readEvents(paths: TurnPaths): TurnEvent[] {
    try {
      return loadTurnEvents(paths.events);
    } catch (error) {
      throw new TurnStoreError(`Unable to load Turn events: ${paths.events}.`, { cause: error });
    }
  }

  private validateEventLog(turnId: string, state: TurnState, events: readonly TurnEvent[]): TurnEvent[] {
    const eventIds = new Set<string>();
    events.forEach((event, index) => {
      if (event.turnId !== turnId) {
        throw new TurnStoreError(`TurnEvent ${event.id} references the wrong Turn: ${turnId}.`);
      }
      if (event.sessionId !== state.sessionId) {
        throw new TurnStoreError(`TurnEvent ${event.id} references the wrong Session.`);
      }
      if (event.sequence !== index) {
        throw new TurnStoreError(
          `TurnEvent sequence is not contiguous for Turn ${turnId}: expected ${index}, received ${event.sequence}.`,
        );
      }
      if (eventIds.has(event.id)) {
        throw new TurnStoreError(`Duplicate TurnEvent id for Turn ${turnId}: ${event.id}.`);
      }
      eventIds.add(event.id);
    });

    if (
      state.checkpoint !== null &&
      (events.length === 0 || state.checkpoint.eventSequence >= events.length)
    ) {
      throw new TurnStoreError(
        `Turn ${turnId} checkpoint does not reference an existing TurnEvent sequence.`,
      );
    }
    return [...events];
  }

  private assertCompleteLayout(turnId: string, paths: TurnPaths): void {
    if (!existsSync(paths.directory) || !isDirectory(paths.directory)) {
      throw new TurnStoreError(`Turn directory does not exist: ${turnId}.`);
    }
    if (!existsSync(paths.metadata) || !existsSync(paths.events)) {
      throw new TurnStoreError(
        `Corrupt Turn layout for ${turnId}: metadata.json and events.jsonl are required.`,
      );
    }
  }

  private getTurnPaths(turnId: string): TurnPaths {
    assertNonEmptyId(turnId, 'turnId');
    if (!isSafeId(turnId)) throw new TurnStoreError(`Invalid turnId: ${turnId}.`);
    const directory = join(this.turnsDirectory, turnId);
    return {
      directory,
      metadata: join(directory, 'metadata.json'),
      events: join(directory, 'events.jsonl'),
    };
  }

  private createTemporaryDirectory(turnId: string): string {
    mkdirSync(this.turnsDirectory, { recursive: true });
    return mkdtempSync(join(this.turnsDirectory, `.${turnId}.tmp-`));
  }

  private removeTemporaryDirectory(directory: string): void {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assertNonEmptyId(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TurnStoreError(`${field} must be a non-empty string.`);
  }
}

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(value);
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
