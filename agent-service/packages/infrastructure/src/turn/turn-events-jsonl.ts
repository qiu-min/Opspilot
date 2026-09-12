import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  CURRENT_TURN_EVENT_VERSION,
  isTurnEvent,
  type TurnEvent,
} from '@opspilot/domain';

/** Errors raised by the append-only Turn event file adapter. */
export class TurnEventsJsonlError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TurnEventsJsonlError';
  }
}

/** Serializes one validated TurnEvent as one JSONL record. */
export function serializeTurnEvent(event: TurnEvent): string {
  if (!isTurnEvent(event)) throw new TurnEventsJsonlError('Cannot serialize an invalid TurnEvent.');
  return `${JSON.stringify(event)}\n`;
}

/** Creates an empty append-only Turn events file. */
export function createTurnEventsFile(filePath: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    throw new TurnEventsJsonlError(`Unable to create Turn events file: ${filePath}`, {
      cause: error,
    });
  }
}

/** Appends one TurnEvent without rewriting existing event history. */
export function appendTurnEvent(filePath: string, event: TurnEvent): void {
  try {
    const existing = readFileSync(filePath);
    const separator = existing.length > 0 && existing.at(-1) !== 10 ? '\n' : '';
    appendFileSync(filePath, `${separator}${serializeTurnEvent(event)}`, { encoding: 'utf8' });
  } catch (error) {
    if (error instanceof TurnEventsJsonlError) throw error;
    throw new TurnEventsJsonlError(`Unable to append Turn event to: ${filePath}`, {
      cause: error,
    });
  }
}

/** Loads and validates all events while preserving their file order. */
export function loadTurnEvents(filePath: string): TurnEvent[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new TurnEventsJsonlError(`Unable to read Turn events file: ${filePath}`, {
      cause: error,
    });
  }
  return parseTurnEventsJsonl(content);
}

/** Parses an append-only Turn JSONL document. */
export function parseTurnEventsJsonl(content: string): TurnEvent[] {
  if (content.length === 0) return [];
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return [];

  const values = lines.map((line, index) => {
    if (line.trim() === '') {
      throw new TurnEventsJsonlError(`Turn events file contains an empty line at ${index + 1}.`);
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new TurnEventsJsonlError(`Invalid JSON in Turn events file at line ${index + 1}.`, {
        cause: error,
      });
    }

    return value;
  });

  return migrateLegacyTurnEvents(values).map((value, index) => {
    if (!isTurnEvent(value)) {
      throw new TurnEventsJsonlError(`Invalid TurnEvent at line ${index + 1}.`);
    }
    return value;
  });
}

/** Upgrades v1 event records in memory before the current strict validator runs. */
function migrateLegacyTurnEvents(values: readonly unknown[]): readonly unknown[] {
  let activeModelCallId: string | undefined;

  return values.map((value) => {
    if (!isRecord(value) || value.version !== 1) return value;

    const migrated = { ...value, version: CURRENT_TURN_EVENT_VERSION };
    if (value.type === 'model_started') {
      activeModelCallId = legacyModelCallId(value.id);
      return { ...migrated, modelCallId: activeModelCallId };
    }
    if (value.type === 'model_completed' || value.type === 'usage_recorded') {
      return {
        ...migrated,
        modelCallId: activeModelCallId ?? legacyModelCallId(value.id),
      };
    }
    return migrated;
  });
}

function legacyModelCallId(eventId: unknown): string {
  return `legacy-model-call-${String(eventId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
