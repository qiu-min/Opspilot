import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ModelChangeEntry,
  SessionEntry,
  SessionFileEntry,
  SessionHeader,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
} from './session-types.js';

export class SessionJsonlError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionJsonlError';
  }
}

export interface LoadedSessionFile {
  readonly header: SessionHeader;
  readonly entries: SessionEntry[];
}

export function serializeSessionRecord(record: SessionFileEntry): string {
  return `${JSON.stringify(record)}\n`;
}

export function createSessionFile(filePath: string, header: SessionHeader): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, serializeSessionRecord(header), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new SessionJsonlError(`Unable to create session file: ${filePath}`, { cause: error });
  }
}

export function appendSessionEntry(filePath: string, entry: SessionEntry): void {
  try {
    appendFileSync(filePath, serializeSessionRecord(entry), { encoding: 'utf8' });
  } catch (error) {
    throw new SessionJsonlError(`Unable to append session entry to: ${filePath}`, { cause: error });
  }
}

export function parseSessionJsonl(content: string): LoadedSessionFile {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.every((line) => line.trim() === '')) {
    throw new SessionJsonlError('Session file is empty.');
  }

  const records = lines.map((line, index) => {
    if (line.trim() === '') {
      throw new SessionJsonlError(`Session file contains an empty line at ${index + 1}.`);
    }

    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new SessionJsonlError(`Invalid JSON in session file at line ${index + 1}.`, {
        cause: error,
      });
    }
  });

  const header = parseHeader(records[0], 1);
  const entries = records.slice(1).map((record, index) => parseEntry(record, index + 2));
  return { header, entries };
}

export function loadSessionFile(filePath: string): LoadedSessionFile {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw new SessionJsonlError(`Session file does not exist: ${filePath}`, { cause: error });
    }
    throw new SessionJsonlError(`Unable to read session file: ${filePath}`, { cause: error });
  }

  return parseSessionJsonl(content);
}

function parseHeader(value: unknown, lineNumber: number): SessionHeader {
  if (!isRecord(value) || value.type !== 'session') {
    throw new SessionJsonlError(
      `First session record must be a session header (line ${lineNumber}).`,
    );
  }
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 1) {
    throw new SessionJsonlError(`Session header has an invalid version (line ${lineNumber}).`);
  }
  if (!isNonEmptyString(value.id)) {
    throw new SessionJsonlError(`Session header has an invalid id (line ${lineNumber}).`);
  }
  if (!isTimestamp(value.timestamp)) {
    throw new SessionJsonlError(`Session header has an invalid timestamp (line ${lineNumber}).`);
  }

  return value as unknown as SessionHeader;
}

function parseEntry(value: unknown, lineNumber: number): SessionEntry {
  if (!isRecord(value)) {
    throw new SessionJsonlError(`Session entry must be a JSON object (line ${lineNumber}).`);
  }
  if (!isNonEmptyString(value.type)) {
    throw new SessionJsonlError(`Session entry has an invalid type (line ${lineNumber}).`);
  }
  if (!isNonEmptyString(value.id)) {
    throw new SessionJsonlError(`Session entry has an invalid id (line ${lineNumber}).`);
  }
  if (!(value.parentId === null || isNonEmptyString(value.parentId))) {
    throw new SessionJsonlError(
      `Session entry ${value.id} has an invalid parentId (line ${lineNumber}).`,
    );
  }
  if (!isTimestamp(value.timestamp)) {
    throw new SessionJsonlError(
      `Session entry ${value.id} has an invalid timestamp (line ${lineNumber}).`,
    );
  }

  switch (value.type) {
    case 'message':
      if (!isRecord(value.message) || !isNonEmptyString(value.message.role)) {
        throw new SessionJsonlError(
          `Message entry ${value.id} has an invalid message (line ${lineNumber}).`,
        );
      }
      return value as unknown as SessionMessageEntry;
    case 'model_change':
      if (!isNonEmptyString(value.provider) || !isNonEmptyString(value.modelId)) {
        throw new SessionJsonlError(
          `Model change entry ${value.id} is incomplete (line ${lineNumber}).`,
        );
      }
      return value as unknown as ModelChangeEntry;
    case 'thinking_level_change':
      if (!isNonEmptyString(value.thinkingLevel)) {
        throw new SessionJsonlError(
          `Thinking level entry ${value.id} is incomplete (line ${lineNumber}).`,
        );
      }
      return value as unknown as ThinkingLevelChangeEntry;
    default:
      throw new SessionJsonlError(`Unsupported session entry type: ${value.type}.`);
  }
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
