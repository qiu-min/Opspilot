import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@opspilot/agent-runtime';
import { appendSessionEntry, createSessionFile, loadSessionFile } from './session-jsonl.js';
import type {
  ModelChangeEntry,
  SessionContext,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
} from './session-types.js';

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

  public appendThinkingLevelChange(thinkingLevel: string): ThinkingLevelChangeEntry {
    if (!isNonEmptyString(thinkingLevel)) {
      throw new Error('Thinking level must be a non-empty string.');
    }

    return this.appendEntry((id, parentId, timestamp) => ({
      type: 'thinking_level_change',
      id,
      parentId,
      timestamp,
      thinkingLevel,
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
    let thinkingLevel = 'off';
    let model: SessionContext['model'] = null;
    const messages: AgentMessage[] = [];

    for (const entry of this.getBranch()) {
      switch (entry.type) {
        case 'message':
          messages.push(cloneValue(entry.message));
          break;
        case 'thinking_level_change':
          thinkingLevel = entry.thinkingLevel;
          break;
        case 'model_change':
          model = { provider: entry.provider, modelId: entry.modelId };
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
      validateEntry(entry);
      if (this.byId.has(entry.id)) {
        throw new SessionTreeError(`Duplicate session entry id: ${entry.id}`);
      }

      const restored = cloneEntry(entry);
      this.entries.push(restored);
      this.byId.set(restored.id, restored);
    }

    validateParentReferences(this.entries, this.byId);
    this.leafId = this.entries.at(-1)?.id ?? null;
    validateAcyclic(this.entries, this.byId);

    if (this.entries.length > 0 && this.entries[0].parentId !== null) {
      throw new SessionTreeError(
        `First session entry must have parentId null: ${this.entries[0].id}`,
      );
    }
    for (const entry of this.entries.slice(1)) {
      if (entry.parentId === null) {
        throw new SessionTreeError(
          `Only the first session entry may have parentId null: ${entry.id}`,
        );
      }
    }
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

function validateEntry(entry: SessionEntry): void {
  if (!isNonEmptyString(entry.id))
    throw new SessionTreeError('Session entry id must be a non-empty string.');
  if (!isTimestamp(entry.timestamp))
    throw new SessionTreeError(`Session entry ${entry.id} has an invalid timestamp.`);
  if (!(entry.parentId === null || isNonEmptyString(entry.parentId))) {
    throw new SessionTreeError(`Session entry ${entry.id} has an invalid parentId.`);
  }

  switch (entry.type) {
    case 'message':
      if (!entry.message || typeof entry.message !== 'object') {
        throw new SessionTreeError(`Message entry ${entry.id} has an invalid message.`);
      }
      break;
    case 'model_change':
      if (!isNonEmptyString(entry.provider) || !isNonEmptyString(entry.modelId)) {
        throw new SessionTreeError(`Model change entry ${entry.id} is incomplete.`);
      }
      break;
    case 'thinking_level_change':
      if (!isNonEmptyString(entry.thinkingLevel)) {
        throw new SessionTreeError(`Thinking level entry ${entry.id} is incomplete.`);
      }
      break;
    default:
      throw new SessionTreeError(
        `Unsupported session entry type: ${(entry as { type: string }).type}.`,
      );
  }
}

function validateAcyclic(
  entries: readonly SessionEntry[],
  byId: ReadonlyMap<string, SessionEntry>,
): void {
  for (const entry of entries) {
    const visited = new Set<string>();
    let current: SessionEntry | undefined = entry;
    while (current) {
      if (visited.has(current.id)) {
        throw new SessionTreeError(`Session entry parentId cycle detected at: ${current.id}`);
      }
      visited.add(current.id);
      if (current.parentId === null) {
        current = undefined;
      } else {
        const parentId = current.parentId;
        current = byId.get(parentId);
        if (!current) {
          throw new SessionTreeError(
            `Session entry ${entry.id} references missing parent: ${parentId}`,
          );
        }
      }
    }
  }
}

function validateParentReferences(
  entries: readonly SessionEntry[],
  byId: ReadonlyMap<string, SessionEntry>,
): void {
  for (const entry of entries) {
    if (entry.parentId !== null && !byId.has(entry.parentId)) {
      throw new SessionTreeError(
        `Session entry ${entry.id} references missing parent: ${entry.parentId}`,
      );
    }
  }
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
