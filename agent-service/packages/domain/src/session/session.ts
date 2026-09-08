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
import {
  SessionEntryNotFoundError,
  SessionMetadataError,
  SessionTreeError,
} from './session-errors.js';
import { normalizeSessionTitle, type SessionMetadata } from './session-metadata.js';

/** The only Session version currently understood by the domain. */
export const CURRENT_SESSION_VERSION = 1;

/** Options for creating a new in-memory Session aggregate. */
export interface SessionCreateOptions {
  readonly id?: string;
  readonly timestamp?: string;
}

/** Durable state used to restore a Session aggregate. */
export interface SessionRestoreInput {
  readonly metadata: SessionMetadata;
  readonly header: SessionHeader;
  readonly entries: readonly SessionEntry[];
}

/**
 * The Session aggregate. It owns durable entry state and tree invariants, but
 * deliberately has no knowledge of external persistence or application callbacks.
 */
export class Session {
  private readonly header: SessionHeader;
  private metadata: SessionMetadata;
  private readonly entries: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private leafId: string | null = null;

  private constructor(
    metadata: SessionMetadata,
    header: SessionHeader,
    entries: readonly SessionEntry[],
  ) {
    validateMetadata(metadata);
    validateHeader(header);
    if (metadata.id !== header.id) {
      throw new SessionMetadataError(
        `Session metadata id does not match history header id: ${metadata.id} !== ${header.id}.`,
      );
    }
    if (metadata.createdAt !== header.timestamp) {
      throw new SessionMetadataError(
        `Session metadata createdAt does not match history header timestamp: ${metadata.createdAt} !== ${header.timestamp}.`,
      );
    }
    this.metadata = { ...metadata };
    this.header = { ...header };
    this.restoreEntries(entries);
    this.metadata = {
      ...this.metadata,
      updatedAt: latestTimestamp(this.metadata.updatedAt, this.metadata.createdAt, this.entries),
    };
  }

  /** Creates an empty in-memory Session. */
  public static create(options: SessionCreateOptions = {}): Session {
    const id = options.id ?? randomUUID();
    const timestamp = options.timestamp ?? new Date().toISOString();
    if (!isNonEmptyString(id)) throw new SessionTreeError('Session header id must be non-empty.');
    if (!isTimestamp(timestamp)) {
      throw new SessionTreeError('Session header timestamp must be a valid timestamp.');
    }

    const metadata: SessionMetadata = {
      id,
      title: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return new Session(
      metadata,
      { type: 'session', version: CURRENT_SESSION_VERSION, id, timestamp },
      [],
    );
  }

  /** Restores a Session and re-validates metadata, tree, and compaction invariants. */
  public static restore(input: SessionRestoreInput): Session;
  public static restore(
    metadata: SessionMetadata,
    header: SessionHeader,
    entries: readonly SessionEntry[],
  ): Session;
  /** Backward-compatible overload for callers that have not yet supplied metadata. */
  public static restore(header: SessionHeader, entries: readonly SessionEntry[]): Session;
  public static restore(
    inputOrMetadata: SessionRestoreInput | SessionMetadata | SessionHeader,
    headerOrEntries?: SessionHeader | readonly SessionEntry[],
    inputEntries?: readonly SessionEntry[],
  ): Session {
    if (isRestoreInput(inputOrMetadata)) {
      return new Session(inputOrMetadata.metadata, inputOrMetadata.header, inputOrMetadata.entries);
    }

    if (isSessionHeader(inputOrMetadata)) {
      const entries = headerOrEntries;
      if (!Array.isArray(entries)) {
        throw new SessionTreeError('Session.restore requires Session entries.');
      }
      const metadata = deriveCompatibilityMetadata(inputOrMetadata, entries);
      return new Session(metadata, inputOrMetadata, entries);
    }

    if (!isSessionHeader(headerOrEntries) || inputEntries === undefined) {
      throw new SessionTreeError('Session.restore requires metadata, header, and entries.');
    }
    return new Session(inputOrMetadata, headerOrEntries, inputEntries);
  }

  public getHeader(): SessionHeader {
    return { ...this.header };
  }

  /** Returns an immutable snapshot of product metadata. */
  public getMetadata(): SessionMetadata {
    return { ...this.metadata };
  }

  /** Returns the Session product id. */
  public getId(): string {
    return this.metadata.id;
  }

  /** Returns the current product title, or null before a title is assigned. */
  public getTitle(): string | null {
    return this.metadata.title;
  }

  /** Returns the immutable creation timestamp. */
  public getCreatedAt(): string {
    return this.metadata.createdAt;
  }

  /** Returns the timestamp of the latest durable Session mutation. */
  public getUpdatedAt(): string {
    return this.metadata.updatedAt;
  }

  /** Renames the Session without adding an entry to the history tree. */
  public rename(title: string): void {
    if (typeof title !== 'string') {
      throw new SessionMetadataError('Session title must be a string.');
    }

    this.metadata = {
      ...this.metadata,
      title: normalizeTitle(title),
      updatedAt: this.nextMutationTimestamp(),
    };
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
    const entry = factory(id, this.leafId, this.nextMutationTimestamp());
    this.entries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this.metadata = { ...this.metadata, updatedAt: entry.timestamp };
    return cloneEntry(entry) as T;
  }

  private nextMutationTimestamp(): string {
    const now = Date.now();
    const current = Date.parse(this.metadata.updatedAt);
    const created = Date.parse(this.metadata.createdAt);
    const timestamp = Math.max(now, current + 1, created);
    return new Date(timestamp).toISOString();
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

function validateMetadata(metadata: SessionMetadata): void {
  if (!isNonEmptyString(metadata.id)) {
    throw new SessionMetadataError('Session metadata id must be a non-empty string.');
  }
  if (metadata.title !== null && !isNonEmptyString(metadata.title)) {
    throw new SessionMetadataError('Session title must be null or a non-empty string.');
  }
  if (!isTimestamp(metadata.createdAt)) {
    throw new SessionMetadataError('Session metadata createdAt is invalid.');
  }
  if (!isTimestamp(metadata.updatedAt)) {
    throw new SessionMetadataError('Session metadata updatedAt is invalid.');
  }
  if (Date.parse(metadata.updatedAt) < Date.parse(metadata.createdAt)) {
    throw new SessionMetadataError('Session metadata updatedAt cannot be earlier than createdAt.');
  }
}

function normalizeTitle(title: string): string {
  try {
    return normalizeSessionTitle(title);
  } catch (error) {
    throw new SessionMetadataError(error instanceof Error ? error.message : String(error));
  }
}

function latestTimestamp(
  current: string,
  createdAt: string,
  entries: readonly SessionEntry[],
): string {
  const lastEntry = entries.at(-1);
  if (lastEntry !== undefined && Date.parse(lastEntry.timestamp) > Date.parse(current)) {
    return lastEntry.timestamp;
  }
  return Date.parse(current) >= Date.parse(createdAt) ? current : createdAt;
}

function deriveCompatibilityMetadata(
  header: SessionHeader,
  entries: readonly SessionEntry[],
): SessionMetadata {
  return {
    id: header.id,
    title: null,
    createdAt: header.timestamp,
    updatedAt: entries.at(-1)?.timestamp ?? header.timestamp,
  };
}

function isRestoreInput(
  value: SessionRestoreInput | SessionMetadata | SessionHeader,
): value is SessionRestoreInput {
  return (
    typeof value === 'object' &&
    value !== null &&
    'metadata' in value &&
    'header' in value &&
    'entries' in value
  );
}

function isSessionHeader(value: unknown): value is SessionHeader {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'session' &&
    'version' in value &&
    'id' in value &&
    'timestamp' in value
  );
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
