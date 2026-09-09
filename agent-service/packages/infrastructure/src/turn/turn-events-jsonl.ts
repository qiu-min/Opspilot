import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { isTurnEvent, type TurnEvent } from '@opspilot/domain';

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

  return lines.map((line, index) => {
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

    if (!isTurnEvent(value)) {
      throw new TurnEventsJsonlError(`Invalid TurnEvent at line ${index + 1}.`);
    }
    return value;
  });
}
