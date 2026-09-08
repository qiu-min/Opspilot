import { randomUUID } from 'node:crypto';
import type { AgentMessage, AgentThinkingLevel } from '@opspilot/agent-runtime';

import {
  CompactionEntry,
  ModelChangeEntry,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
  isAgentThinkingLevel,
} from './session-entry.js';
import { SessionEntryNotFoundError, SessionTreeError } from './session-errors.js';

/** The only Session version currently understood by the domain. */
export const CURRENT_SESSION_VERSION = 1;

/** Options for creating a new in-memory Session aggregate. */
export interface SessionCreateOptions {
  readonly id?: string;
  readonly timestamp?: string;
}

/**
 * The Session aggregate. It owns durable entry state and tree invariants, but
 * deliberately has no knowledge of files, JSONL, repositories, or callbacks.
 */
export class Session {
  private readonly header: SessionHeader;
  private readonly entries: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;

  private constructor(header: SessionHeader, entries: readonly SessionEntry[]) {
    validateHeader(header);
    this.header = { ...header };
    this.restoreEntries(entries);
  }

  /** Creates an empty in-memory Session. */
  public static create(options: SessionCreateOptions = {}): Session {
    const id = options.id ?? randomUUID();
    const timestamp = options.timestamp ?? new Date().toISOString();
    if (!isNonEmptyString(id)) throw new SessionTreeError('Session header id must be non-empty.');
    if (!isTimestamp(timestamp)) {
      throw new SessionTreeError('Session header timestamp must be a valid timestamp.');
    }

    return new Session({ type: 'session', version: CURRENT_SESSION_VERSION, id, timestamp }, []);
  }

  /** Restores a Session and re-validates all tree and compaction invariants. */
  public static restore(header: SessionHeader, entries: readonly SessionEntry[]): Session {
    return new Session(header, entries);
  }

  public getHeader(): SessionHeader {
    return { ...this.header };
  }

  public getLeafId(): string | null {
    return this.leafId;
  }

  public getEntry(entryId: string): SessionEntry | undefined {
    const entry = this.byId.get(entryId);
    return entry === undefined ? undefined : cloneEntry(entry);
  }

  public getEntries(): SessionEntry[] {
    return this.entries.map(cloneEntry);
  }

  /** Returns the path from the selected leaf (or supplied entry) to the root. */
  public getBranch(fromId?: string): SessionEntry[] {
    const startId = fromId ?? this.leafId;
    if (startId === null || startId === undefined) return [];

    const start = this.byId.get(startId);
    if (start === undefined) throw new SessionEntryNotFoundError(startId);

    return this.buildBranch(start).map(cloneEntry);
  }

  /** Selects an existing entry as the active branch leaf. */
  public branch(entryId: string): void {
    if (!this.byId.has(entryId)) throw new SessionEntryNotFoundError(entryId);
    this.leafId = entryId;
  }

  public appendMessage(message: AgentMessage): SessionMessageEntry {
    return this.appendEntry((id, parentId, timestamp) => ({
      type: 'message',
      id,
      parentId,
      timestamp,
      message: cloneValue(message),
    }));
  }

  public appendModelChange(provider: string, modelId: string): ModelChangeEntry {
    if (!isNonEmptyString(provider) || !isNonEmptyString(modelId)) {
      throw new SessionTreeError('Model change requires a non-empty provider and modelId.');
    }

    return this.appendEntry((id, parentId, timestamp) => ({
      type: 'model_change',
      id,
      parentId,
      timestamp,
      provider,
      modelId,
    }));
  }

  public appendThinkingLevelChange(thinkingLevel: AgentThinkingLevel): ThinkingLevelChangeEntry {
    if (!isAgentThinkingLevel(thinkingLevel)) {
      throw new SessionTreeError(`Unsupported thinking level: ${String(thinkingLevel)}.`);
    }

    return this.appendEntry((id, parentId, timestamp) => ({
      type: 'thinking_level_change',
      id,
      parentId,
      timestamp,
      thinkingLevel,
    }));
  }

  /** Appends a summary boundary without removing any existing entries. */
  public appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): CompactionEntry {
    validateCompactionValues(summary, firstKeptEntryId, tokensBefore);

    const firstKeptEntry = this.byId.get(firstKeptEntryId);
    if (firstKeptEntry === undefined) {
      throw new SessionEntryNotFoundError(firstKeptEntryId);
    }
    if (firstKeptEntry.type === 'compaction') {
      throw new SessionTreeError('Compaction firstKeptEntryId cannot point to a compaction entry.');
    }
    if (!this.getBranch().some((entry) => entry.id === firstKeptEntryId)) {
      throw new SessionTreeError(
        `Compaction firstKeptEntryId must belong to the active branch: ${firstKeptEntryId}`,
      );
    }

    return this.appendEntry((id, parentId, timestamp) => ({
      type: 'compaction',
      id,
      parentId,
      timestamp,
      summary,
      firstKeptEntryId,
      tokensBefore,
    }));
  }

  private appendEntry<T extends SessionEntry>(
    factory: (id: string, parentId: string | null, timestamp: string) => T,
  ): T {
    const id = this.createUniqueEntryId();
    const entry = factory(id, this.leafId, new Date().toISOString());
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    return cloneEntry(entry) as T;
  }

  private createUniqueEntryId(): string {
    let id = randomUUID();
    while (this.byId.has(id)) id = randomUUID();
    return id;
  }

  private restoreEntries(entries: readonly SessionEntry[]): void {
    for (const entry of entries) {
      validateEntry(entry);
      if (this.byId.has(entry.id)) {
        throw new SessionTreeError(`Duplicate session entry id: ${entry.id}`);
      }

      const restored = cloneEntry(entry);
      this.entries.push(restored);
      this.byId.set(restored.id, restored);
    }

    const rootEntries = this.entries.filter((entry) => entry.parentId === null);
    if (this.entries.length > 0 && rootEntries.length === 0) {
      throw new SessionTreeError('Session tree must contain a root entry.');
    }
    if (rootEntries.length > 1) {
      throw new SessionTreeError('Session tree must contain exactly one root entry.');
    }

    for (const entry of this.entries) {
      if (entry.parentId !== null && !this.byId.has(entry.parentId)) {
        throw new SessionTreeError(
          `Session entry ${entry.id} references missing parent: ${entry.parentId}`,
        );
      }
      this.buildBranch(entry);
    }

    for (const entry of this.entries) {
      if (entry.type !== 'compaction') continue;
      validateCompactionValues(entry.summary, entry.firstKeptEntryId, entry.tokensBefore);
      const firstKeptEntry = this.byId.get(entry.firstKeptEntryId);
      if (firstKeptEntry === undefined) {
        throw new SessionEntryNotFoundError(entry.firstKeptEntryId);
      }
      if (firstKeptEntry.type === 'compaction') {
        throw new SessionTreeError(
          'Compaction firstKeptEntryId cannot point to a compaction entry.',
        );
      }
      const parentBranch =
        entry.parentId === null ? [] : this.buildBranch(this.byId.get(entry.parentId)!);
      if (!parentBranch.some((branchEntry) => branchEntry.id === entry.firstKeptEntryId)) {
        throw new SessionTreeError(
          `Compaction firstKeptEntryId must belong to the active branch: ${entry.firstKeptEntryId}`,
        );
      }
    }

    this.leafId = this.entries.at(-1)?.id ?? null;
  }

  private buildBranch(start: SessionEntry): SessionEntry[] {
    const path: SessionEntry[] = [];
    const visited = new Set<string>();
    let current: SessionEntry | undefined = start;

    while (current !== undefined) {
      if (visited.has(current.id)) {
        throw new SessionTreeError(`Session entry parentId cycle detected at: ${current.id}`);
      }
      visited.add(current.id);
      path.push(current);

      if (current.parentId === null) break;
      current = this.byId.get(current.parentId);
      if (current === undefined) {
        throw new SessionTreeError(
          `Session entry ${path.at(-1)!.id} references missing parent: ${path.at(-1)!.parentId}`,
        );
      }
    }

    path.reverse();
    return path;
  }
}

function validateHeader(header: SessionHeader): void {
  if (header.type !== 'session')
    throw new SessionTreeError('Session header type must be "session".');
  if (header.version !== CURRENT_SESSION_VERSION) {
    throw new SessionTreeError(`Unsupported session version: ${String(header.version)}.`);
  }
  if (!isNonEmptyString(header.id)) {
    throw new SessionTreeError('Session header id must be a non-empty string.');
  }
  if (!isTimestamp(header.timestamp)) {
    throw new SessionTreeError('Session header timestamp is invalid.');
  }
}

function validateEntry(entry: SessionEntry): void {
  if (!isNonEmptyString(entry.id))
    throw new SessionTreeError('Session entry id must be non-empty.');
  if (!(entry.parentId === null || isNonEmptyString(entry.parentId))) {
    throw new SessionTreeError(`Session entry ${entry.id} has an invalid parentId.`);
  }
  if (!isTimestamp(entry.timestamp)) {
    throw new SessionTreeError(`Session entry ${entry.id} has an invalid timestamp.`);
  }

  switch (entry.type) {
    case 'message':
      if (entry.message === undefined || typeof entry.message !== 'object') {
        throw new SessionTreeError(`Message entry ${entry.id} has an invalid message.`);
      }
      break;
    case 'model_change':
      if (!isNonEmptyString(entry.provider) || !isNonEmptyString(entry.modelId)) {
        throw new SessionTreeError(`Model change entry ${entry.id} is incomplete.`);
      }
      break;
    case 'thinking_level_change':
      if (!isAgentThinkingLevel(entry.thinkingLevel)) {
        throw new SessionTreeError(`Thinking level entry ${entry.id} is invalid.`);
      }
      break;
    case 'compaction':
      validateCompactionValues(entry.summary, entry.firstKeptEntryId, entry.tokensBefore);
      break;
    default:
      throw new SessionTreeError('Unsupported session entry type.');
  }
}

function validateCompactionValues(
  summary: string,
  firstKeptEntryId: string,
  tokensBefore: number,
): void {
  if (!isNonEmptyString(summary))
    throw new SessionTreeError('Compaction summary must be non-empty.');
  if (!isNonEmptyString(firstKeptEntryId)) {
    throw new SessionTreeError('Compaction firstKeptEntryId must be non-empty.');
  }
  if (!Number.isInteger(tokensBefore) || tokensBefore < 0) {
    throw new SessionTreeError('Compaction tokensBefore must be a non-negative integer.');
  }
}

function cloneEntry(entry: SessionEntry): SessionEntry {
  if (entry.type === 'message') return { ...entry, message: cloneValue(entry.message) };
  return { ...entry };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}
