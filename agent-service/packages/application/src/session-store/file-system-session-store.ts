import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { Session, type SessionEntry, type SessionMetadata } from '@opspilot/domain';

import {
  appendSessionEntry,
  createSessionFile,
  parseSessionJsonl,
  readSessionFileBytes,
  SessionJsonlError,
} from './session-jsonl.js';
import {
  loadSessionMetadata,
  rewriteSessionMetadataAtomically,
  writeSessionMetadataFile,
} from './session-metadata-json.js';
import { SessionStoreError } from './session-store-errors.js';
import type { SessionStore } from './session-store.js';

const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface SessionPaths {
  readonly directory: string;
  readonly metadata: string;
  readonly history: string;
  readonly legacy: string;
}

/** Stores Session metadata and append-only history in the current filesystem layout. */
export class FileSystemSessionStore implements SessionStore {
  private readonly baseDirectory: string;

  public constructor(baseDirectory: string) {
    this.baseDirectory = baseDirectory;
  }

  /** Creates and publishes a complete new Session directory atomically. */
  public create(): Session {
    const sessionId = randomUUID();
    const now = new Date().toISOString();
    const session = Session.create({ id: sessionId, timestamp: now });
    const paths = this.getSessionPaths(sessionId);
    const temporaryDirectory = this.createTemporaryDirectory(sessionId);

    try {
      writeSessionMetadataFile(join(temporaryDirectory, 'metadata.json'), session.getMetadata());
      createSessionFile(join(temporaryDirectory, 'history.jsonl'), session.getHeader());
      this.publishTemporaryDirectory(temporaryDirectory, paths.directory, sessionId);
      return session;
    } catch (error) {
      this.removeTemporaryDirectory(temporaryDirectory);
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError(`Unable to create Session ${sessionId}.`, { cause: error });
    }
  }

  /** Loads the new layout first, or parses and lazily migrates a legacy file. */
  public load(sessionId: string): Session {
    this.assertValidSessionId(sessionId);
    const paths = this.getSessionPaths(sessionId);

    if (existsSync(paths.directory)) return this.loadNewLayout(sessionId, paths);
    if (existsSync(paths.legacy)) return this.loadAndMigrateLegacy(sessionId, paths);

    throw new SessionJsonlError(`Session file does not exist: ${paths.legacy}`);
  }

  /** Appends history first, then atomically advances metadata.updatedAt. */
  public appendEntry(sessionId: string, entry: SessionEntry): void {
    this.assertValidSessionId(sessionId);
    const paths = this.getSessionPaths(sessionId);
    this.assertCompleteNewLayout(sessionId, paths);

    appendSessionEntry(paths.history, entry);

    try {
      const metadata = loadSessionMetadata(paths.metadata);
      const updatedAt = latestTimestamp(metadata.updatedAt, metadata.createdAt, entry.timestamp);
      if (updatedAt !== metadata.updatedAt) {
        rewriteSessionMetadataAtomically(paths.metadata, { ...metadata, updatedAt });
      }
    } catch (error) {
      throw new SessionStoreError(
        `History entry was appended, but metadata update failed for Session ${sessionId}.`,
        { cause: error },
      );
    }
  }

  /** Atomically replaces the complete mutable metadata snapshot. */
  public saveMetadata(sessionId: string, metadata: SessionMetadata): void {
    this.assertValidSessionId(sessionId);
    const paths = this.getSessionPaths(sessionId);
    this.assertCompleteNewLayout(sessionId, paths);
    if (metadata.id !== sessionId) {
      throw new SessionStoreError(
        `Session metadata id does not match requested sessionId: ${metadata.id} !== ${sessionId}.`,
      );
    }

    rewriteSessionMetadataAtomically(paths.metadata, metadata);
  }

  private loadNewLayout(sessionId: string, paths: SessionPaths): Session {
    if (!isDirectory(paths.directory)) {
      throw new SessionStoreError(
        `Corrupt Session layout: expected a directory at ${paths.directory}.`,
      );
    }
    this.assertCompleteNewLayout(sessionId, paths);

    const metadata = loadSessionMetadata(paths.metadata);
    if (metadata.id !== sessionId) {
      throw new SessionStoreError(
        `Session metadata id does not match requested sessionId: ${metadata.id} !== ${sessionId}.`,
      );
    }

    const loaded = parseSessionJsonl(readSessionFileBytes(paths.history).toString('utf8'));
    this.assertHeaderId(sessionId, loaded.header.id);
    const session = Session.restore({
      metadata,
      header: loaded.header,
      entries: loaded.entries,
    });

    if (session.getUpdatedAt() !== metadata.updatedAt) {
      this.repairReconciledMetadata(sessionId, paths, session.getMetadata());
    }
    return session;
  }

  private loadAndMigrateLegacy(sessionId: string, paths: SessionPaths): Session {
    const legacyBytes = readSessionFileBytes(paths.legacy);
    const loaded = parseSessionJsonl(legacyBytes.toString('utf8'));
    this.assertHeaderId(sessionId, loaded.header.id);

    const metadata: SessionMetadata = {
      id: loaded.header.id,
      title: null,
      createdAt: loaded.header.timestamp,
      updatedAt: loaded.entries.at(-1)?.timestamp ?? loaded.header.timestamp,
    };
    const session = Session.restore({
      metadata,
      header: loaded.header,
      entries: loaded.entries,
    });

    this.migrateLegacy(paths, session.getMetadata(), legacyBytes);
    return session;
  }

  private migrateLegacy(
    paths: SessionPaths,
    metadata: SessionMetadata,
    historyBytes: Buffer,
  ): void {
    if (existsSync(paths.directory)) {
      throw new SessionStoreError(
        `Cannot migrate legacy Session because the new layout already exists: ${paths.directory}.`,
      );
    }

    const temporaryDirectory = this.createTemporaryDirectory(metadata.id);
    try {
      writeSessionMetadataFile(join(temporaryDirectory, 'metadata.json'), metadata);
      writeFileSync(join(temporaryDirectory, 'history.jsonl'), historyBytes, { flag: 'wx' });
      this.publishTemporaryDirectory(temporaryDirectory, paths.directory, metadata.id);
    } catch (error) {
      this.removeTemporaryDirectory(temporaryDirectory);
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError(`Unable to migrate legacy Session ${metadata.id}.`, {
        cause: error,
      });
    }
  }

  private repairReconciledMetadata(
    sessionId: string,
    paths: SessionPaths,
    metadata: SessionMetadata,
  ): void {
    try {
      rewriteSessionMetadataAtomically(paths.metadata, metadata);
    } catch (error) {
      throw new SessionStoreError(
        `Session ${sessionId} history is valid, but metadata reconciliation failed.`,
        { cause: error },
      );
    }
  }

  private assertCompleteNewLayout(sessionId: string, paths: SessionPaths): void {
    if (!existsSync(paths.metadata) || !existsSync(paths.history)) {
      throw new SessionStoreError(
        `Corrupt or incomplete new Session layout for ${sessionId}: both metadata.json and history.jsonl are required.`,
      );
    }
  }

  private publishTemporaryDirectory(
    temporaryDirectory: string,
    finalDirectory: string,
    sessionId: string,
  ): void {
    if (existsSync(finalDirectory)) {
      throw new SessionStoreError(
        `Cannot publish Session ${sessionId}: destination already exists at ${finalDirectory}.`,
      );
    }
    renameSync(temporaryDirectory, finalDirectory);
  }

  private createTemporaryDirectory(sessionId: string): string {
    mkdirSync(this.baseDirectory, { recursive: true });
    return mkdtempSync(join(this.baseDirectory, `.${sessionId}.tmp-`));
  }

  private removeTemporaryDirectory(directory: string): void {
    rmSync(directory, { recursive: true, force: true });
  }

  private getSessionPaths(sessionId: string): SessionPaths {
    this.assertValidSessionId(sessionId);
    const directory = join(this.baseDirectory, sessionId);
    return {
      directory,
      metadata: join(directory, 'metadata.json'),
      history: join(directory, 'history.jsonl'),
      legacy: join(this.baseDirectory, `${sessionId}.jsonl`),
    };
  }

  private assertHeaderId(requestedId: string, storedId: string): void {
    if (storedId !== requestedId) {
      throw new SessionStoreError(
        `Session header id does not match requested sessionId: ${storedId} !== ${requestedId}.`,
      );
    }
  }

  private assertValidSessionId(sessionId: string): void {
    if (typeof sessionId !== 'string' || !sessionIdPattern.test(sessionId)) {
      throw new SessionStoreError(`Invalid sessionId: ${sessionId}.`);
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function latestTimestamp(current: string, createdAt: string, entryTimestamp: string): string {
  const currentTime = Date.parse(current);
  const createdTime = Date.parse(createdAt);
  const entryTime = Date.parse(entryTimestamp);
  if (!Number.isFinite(entryTime)) {
    throw new SessionStoreError('Session entry timestamp is invalid.');
  }
  if (entryTime > currentTime && entryTime >= createdTime) return entryTimestamp;
  return currentTime >= createdTime ? current : createdAt;
}
