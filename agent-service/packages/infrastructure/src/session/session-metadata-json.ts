import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { SessionMetadata, SessionResourceRef } from '@opspilot/domain';

/** Current version of the filesystem metadata document. */
export const CURRENT_SESSION_METADATA_VERSION = 1;

/** Persistence-side JSON representation of Session metadata. */
export interface SessionMetadataRecord {
  readonly version: 1;
  readonly id: string;
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resources: readonly SessionResourceRef[];
  readonly activeResourceId: string | null;
}

/** Raised when metadata.json cannot be read or does not satisfy its schema. */
export class SessionMetadataPersistenceError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionMetadataPersistenceError';
  }
}

/** Serializes Domain metadata into the versioned filesystem DTO. */
export function serializeSessionMetadata(metadata: SessionMetadata): string {
  validateSessionMetadata(metadata);
  const resources = parseSessionResources(metadata.resources);
  const record: SessionMetadataRecord = {
    version: CURRENT_SESSION_METADATA_VERSION,
    id: metadata.id,
    title: metadata.title,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    resources: resources.map((resource) => ({ ...resource })),
    activeResourceId: metadata.activeResourceId ?? null,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Parses and validates a metadata.json document without unchecked shape casts. */
export function parseSessionMetadata(content: string): SessionMetadata {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch (error) {
    throw new SessionMetadataPersistenceError('metadata.json contains invalid JSON.', {
      cause: error,
    });
  }

  if (!isRecord(value)) {
    throw new SessionMetadataPersistenceError('metadata.json must contain a JSON object.');
  }
  if (value.version !== CURRENT_SESSION_METADATA_VERSION) {
    throw new SessionMetadataPersistenceError(
      `metadata.json has unsupported version: ${String(value.version)}.`,
    );
  }
  if (!isNonEmptyString(value.id)) {
    throw new SessionMetadataPersistenceError('metadata.json id must be a non-empty string.');
  }
  if (value.title !== null && !isNonEmptyString(value.title)) {
    throw new SessionMetadataPersistenceError(
      'metadata.json title must be null or a non-empty string.',
    );
  }
  if (!isTimestamp(value.createdAt)) {
    throw new SessionMetadataPersistenceError('metadata.json createdAt is invalid.');
  }
  if (!isTimestamp(value.updatedAt)) {
    throw new SessionMetadataPersistenceError('metadata.json updatedAt is invalid.');
  }
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new SessionMetadataPersistenceError(
      'metadata.json updatedAt cannot be earlier than createdAt.',
    );
  }

  const resources = parseSessionResources(value.resources);
  const activeResourceId = parseActiveResourceId(value.activeResourceId);
  if (activeResourceId !== null && !resources.some((resource) => resource.id === activeResourceId)) {
    throw new SessionMetadataPersistenceError(
      `metadata.json activeResourceId must reference a registered resource: ${activeResourceId}.`,
    );
  }

  return {
    id: value.id,
    title: value.title === null ? null : value.title.trim(),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    resources,
    activeResourceId,
  };
}

/** Writes a complete metadata document to a path that is already in a temp directory. */
export function writeSessionMetadataFile(filePath: string, metadata: SessionMetadata): void {
  try {
    writeFileSync(filePath, serializeSessionMetadata(metadata), {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    throw new SessionMetadataPersistenceError(`Unable to write metadata.json: ${filePath}`, {
      cause: error,
    });
  }
}

/** Reads and validates one metadata.json document. */
export function loadSessionMetadata(filePath: string): SessionMetadata {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new SessionMetadataPersistenceError(`Unable to read metadata.json: ${filePath}`, {
      cause: error,
    });
  }

  return parseSessionMetadata(content);
}

/** Replaces metadata.json through a complete temp file followed by rename. */
export function rewriteSessionMetadataAtomically(
  filePath: string,
  metadata: SessionMetadata,
): void {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  try {
    writeSessionMetadataFile(temporaryPath, metadata);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    throw new SessionMetadataPersistenceError(
      `Unable to atomically replace metadata.json: ${filePath}`,
      { cause: error },
    );
  } finally {
    if (existsSync(temporaryPath)) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The original persistence error is more useful than cleanup failure.
      }
    }
  }
}

function validateSessionMetadata(metadata: SessionMetadata): void {
  if (!isNonEmptyString(metadata.id)) {
    throw new SessionMetadataPersistenceError('Session metadata id must be non-empty.');
  }
  if (metadata.title !== null && !isNonEmptyString(metadata.title)) {
    throw new SessionMetadataPersistenceError('Session metadata title must be null or non-empty.');
  }
  if (!isTimestamp(metadata.createdAt) || !isTimestamp(metadata.updatedAt)) {
    throw new SessionMetadataPersistenceError('Session metadata timestamps must be valid.');
  }
  if (Date.parse(metadata.updatedAt) < Date.parse(metadata.createdAt)) {
    throw new SessionMetadataPersistenceError(
      'Session metadata updatedAt cannot be earlier than createdAt.',
    );
  }
  parseSessionResources(metadata.resources);
  const activeResourceId = parseActiveResourceId(metadata.activeResourceId);
  if (
    activeResourceId !== null &&
    !metadata.resources.some((resource) => resource.id === activeResourceId)
  ) {
    throw new SessionMetadataPersistenceError(
      `Session metadata activeResourceId must reference a registered resource: ${activeResourceId}.`,
    );
  }
}

function parseActiveResourceId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isNonEmptyString(value)) {
    throw new SessionMetadataPersistenceError(
      'metadata.json activeResourceId must be null or a non-empty string.',
    );
  }
  return value;
}

function parseSessionResources(value: unknown): readonly SessionResourceRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SessionMetadataPersistenceError('metadata.json resources must be an array.');
  }

  const resources: SessionResourceRef[] = [];
  const keys = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !isNonEmptyString(item.id) || item.kind !== 'excel') {
      throw new SessionMetadataPersistenceError(
        `metadata.json resources[${index}] must contain a non-empty id and supported kind.`,
      );
    }
    const resource = { id: item.id, kind: 'excel' as const };
    const key = `${resource.kind}\u0000${resource.id}`;
    if (keys.has(key)) {
      throw new SessionMetadataPersistenceError(
        `metadata.json contains duplicate resource: ${resource.kind}/${resource.id}.`,
      );
    }
    keys.add(key);
    resources.push(resource);
  }
  return resources;
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
