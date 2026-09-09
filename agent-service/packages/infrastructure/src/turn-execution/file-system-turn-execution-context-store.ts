import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { TurnExecutionContext, TurnExecutionContextStore } from '@opspilot/application';

/** Raised when execution.json cannot be read or does not satisfy its schema. */
export class TurnExecutionContextStoreError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TurnExecutionContextStoreError';
  }
}

/** Stores the minimal non-Domain inputs needed to recover a Turn. */
export class FileSystemTurnExecutionContextStore implements TurnExecutionContextStore {
  private readonly turnsDirectory: string;

  public constructor(storageRoot: string) {
    this.turnsDirectory = join(storageRoot, 'turns');
  }

  public save(turnId: string, context: TurnExecutionContext): void {
    const filePath = this.getPath(turnId);
    validateContext(context);
    mkdirSync(join(this.turnsDirectory, turnId), { recursive: true });
    const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(context, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      renameSync(temporaryPath, filePath);
    } catch (error) {
      throw new TurnExecutionContextStoreError(
        `Unable to atomically write execution context for Turn ${turnId}.`,
        { cause: error },
      );
    } finally {
      if (existsSync(temporaryPath)) {
        try {
          unlinkSync(temporaryPath);
        } catch {
          // Preserve the original persistence error.
        }
      }
    }
  }

  public load(turnId: string): TurnExecutionContext | null {
    const filePath = this.getPath(turnId);
    if (!existsSync(filePath)) return null;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch (error) {
      throw new TurnExecutionContextStoreError(
        `Unable to read execution context for Turn ${turnId}.`,
        { cause: error },
      );
    }

    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new TurnExecutionContextStoreError(
        `Turn ${turnId} execution.json contains invalid JSON.`,
        { cause: error },
      );
    }
    try {
      validateContext(value);
      return structuredClone(value);
    } catch (error) {
      if (error instanceof TurnExecutionContextStoreError) throw error;
      throw new TurnExecutionContextStoreError(`Turn ${turnId} execution.json is invalid.`, {
        cause: error,
      });
    }
  }

  private getPath(turnId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(turnId)) {
      throw new TurnExecutionContextStoreError(`Invalid turnId: ${turnId}.`);
    }
    return join(this.turnsDirectory, turnId, 'execution.json');
  }
}

function validateContext(value: unknown): asserts value is TurnExecutionContext {
  if (!isRecord(value) || value.version !== 1) {
    throw new TurnExecutionContextStoreError('Execution context version must be 1.');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'version' && key !== 'excelResource')) {
    throw new TurnExecutionContextStoreError('Execution context contains unsupported fields.');
  }
  if (value.excelResource === undefined) return;
  const resource = value.excelResource;
  if (!isRecord(resource)) {
    throw new TurnExecutionContextStoreError('Execution context excelResource is invalid.');
  }
  if (!isNonEmptyString(resource.id) || !isNonEmptyString(resource.filePath)) {
    throw new TurnExecutionContextStoreError(
      'Execution context excelResource requires id and filePath.',
    );
  }
  const resourceKeys = Object.keys(resource);
  if (resourceKeys.some((key) => key !== 'id' && key !== 'filePath')) {
    throw new TurnExecutionContextStoreError(
      'Execution context excelResource contains unsupported fields.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
