import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@opspilot/agent-runtime';
import {
  appendSessionEntry,
  createSessionFile,
  isAgentThinkingLevel,
  loadSessionFile,
} from './session-jsonl.js';
import { buildSessionMessageProjection } from './session-projection.js';
import type {
  ModelChangeEntry,
  CompactionEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
} from './session-types.js';
import type { AgentThinkingLevel } from '@opspilot/agent-runtime';

export const CURRENT_SESSION_VERSION = 1;

export interface SessionManagerCreateOptions {
  readonly id?: string;
  readonly timestamp?: string;
  readonly filePath?: string;
}

export class SessionEntryNotFoundError extends Error {
  constructor(entryId: string) {
    super(`Session entry not found: ${entryId}`);
    this.name = 'SessionEntryNotFoundError';
  }
}

export class SessionTreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionTreeError';
  }
}

type PersistEntry = (entry: SessionEntry) => void;

export class SessionManager {
  private readonly header: SessionHeader;
  private readonly entries: SessionEntry[] = [];
  private readonly byId = new Map<string, SessionEntry>();
  private readonly persistEntry?: PersistEntry;
  private leafId: string | null = null;

  private constructor(
    header: SessionHeader,
    entries: readonly SessionEntry[] = [],
    persistEntry?: PersistEntry,
  ) {
    validateHeader(header);
    this.header = { ...header };
    this.persistEntry = persistEntry;
    this.restoreEntries(entries);
  }

  public static create(options: SessionManagerCreateOptions = {}): SessionManager {
    const header = createHeader(options);
    if (!options.filePath) return new SessionManager(header);

    createSessionFile(options.filePath, header);
    return new SessionManager(header, [], (entry) => appendSessionEntry(options.filePath!, entry));
  }

  public static inMemory(
    options: Omit<SessionManagerCreateOptions, 'filePath'> = {},
  ): SessionManager {
    return SessionManager.create(options);
  }

  public static createPersisted(
    filePath: string,
    options: Omit<SessionManagerCreateOptions, 'filePath'> = {},
  ): SessionManager {
    return SessionManager.create({ ...options, filePath });
  }

  public static load(filePath: string): SessionManager {
    const loaded = loadSessionFile(filePath);
    return new SessionManager(loaded.header, loaded.entries, (entry) =>
      appendSessionEntry(filePath, entry),
    );
  }

  public getHeader(): SessionHeader {
    return { ...this.header };
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
      throw new Error('Model change requires a non-empty provider and modelId.');
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
      throw new Error(`Unsupported thinking level: ${String(thinkingLevel)}.`);
    }

    return this.appendEntry((id, parentId, timestamp) => ({
      type: 'thinking_level_change',
      id,
      parentId,
      timestamp,
      thinkingLevel,
    }));
  }

  /** Appends a durable summary boundary without removing any existing entries. */
  public appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
  ): CompactionEntry {
    if (!isNonEmptyString(summary)) throw new Error('Compaction summary must be non-empty.');
    if (!isNonEmptyString(firstKeptEntryId)) {
      throw new Error('Compaction firstKeptEntryId must be non-empty.');
    }
    if (!Number.isInteger(tokensBefore) || tokensBefore < 0) {
      throw new Error('Compaction tokensBefore must be a non-negative integer.');
    }

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

  public getLeafId(): string | null {
    return this.leafId;
  }

  public getEntry(entryId: string): SessionEntry | undefined {
    const entry = this.byId.get(entryId);
    return entry ? cloneEntry(entry) : undefined;
  }

  public getEntries(): SessionEntry[] {
    return this.entries.map(cloneEntry);
  }

  public getBranch(fromId?: string): SessionEntry[] {
    const startId = fromId ?? this.leafId;
    if (startId === null || startId === undefined) return [];

    const start = this.byId.get(startId);
    if (!start) throw new SessionEntryNotFoundError(startId);

    const path: SessionEntry[] = [];
    const visited = new Set<string>();
    let current: SessionEntry | undefined = start;

    while (current) {
      if (visited.has(current.id)) {
        throw new SessionTreeError(`Session entry parentId cycle detected at: ${current.id}`);
      }
      visited.add(current.id);
      path.push(current);

      if (current.parentId === null) break;
      current = this.byId.get(current.parentId);
      if (!current) {
        throw new SessionTreeError(
          `Session entry ${path.at(-1)!.id} references missing parent: ${path.at(-1)!.parentId}`,
        );
      }
    }

    path.reverse();
    return path.map(cloneEntry);
  }

  public branch(entryId: string): void {
    if (!this.byId.has(entryId)) throw new SessionEntryNotFoundError(entryId);
    this.leafId = entryId;
  }

  public buildSessionContext(): SessionContext {
    const branch = this.getBranch();
    const projection = buildSessionMessageProjection(branch);
    let thinkingLevel: SessionContext['thinkingLevel'] = 'off';
    let model: SessionContext['model'] = null;
    const messages: AgentMessage[] = projection.messages.map((item) => cloneValue(item.message));

    for (const entry of branch) {
      switch (entry.type) {
        case 'message':
          if (entry.message.role === 'assistant') {
            model = {
              provider: entry.message.provider,
              modelId: entry.message.model,
            };
          }

          break;
        case 'thinking_level_change':
          thinkingLevel = entry.thinkingLevel;
          break;
        case 'model_change':
          model = { provider: entry.provider, modelId: entry.modelId };
          break;
        case 'compaction':
          break;
      }
    }

    return { messages, thinkingLevel, model };
  }

  private appendEntry<T extends SessionEntry>(
    factory: (id: string, parentId: string | null, timestamp: string) => T,
  ): T {
    const id = this.createUniqueEntryId();
    const entry = factory(id, this.leafId, new Date().toISOString());

    // Persist before publishing the entry to the in-memory index. A failed write
    // therefore leaves the manager unchanged and safe to retry.
    this.persistEntry?.(entry);
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
      // session-jsonl validates durable log shape and append order before this
      // method is called. This guard only protects the in-memory index if the
      // restore source changes in the future.
      if (this.byId.has(entry.id)) {
        throw new SessionTreeError(`Duplicate session entry id: ${entry.id}`);
      }

      const restored = cloneEntry(entry);
      this.entries.push(restored);
      this.byId.set(restored.id, restored);
    }

    this.leafId = this.entries.at(-1)?.id ?? null;
  }
}

function createHeader(options: SessionManagerCreateOptions): SessionHeader {
  const id = options.id ?? randomUUID();
  const timestamp = options.timestamp ?? new Date().toISOString();
  if (!isNonEmptyString(id)) throw new Error('Session header id must be a non-empty string.');
  if (!isTimestamp(timestamp))
    throw new Error('Session header timestamp must be a valid timestamp.');

  return { type: 'session', version: CURRENT_SESSION_VERSION, id, timestamp };
}

function validateHeader(header: SessionHeader): void {
  if (header.type !== 'session')
    throw new SessionTreeError('Session header must have type "session".');
  if (header.version !== CURRENT_SESSION_VERSION) {
    throw new SessionTreeError(`Unsupported session version: ${String(header.version)}.`);
  }
  if (!isNonEmptyString(header.id))
    throw new SessionTreeError('Session header id must be a non-empty string.');
  if (!isTimestamp(header.timestamp))
    throw new SessionTreeError('Session header timestamp is invalid.');
}

function cloneEntry(entry: SessionEntry): SessionEntry {
  if (entry.type === 'message') {
    return { ...entry, message: cloneValue(entry.message) };
  }
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
