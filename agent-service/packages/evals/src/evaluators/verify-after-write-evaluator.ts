import type {
  ExecuteTurnResult,
  ToolCompletedEvent,
  Turn,
  TurnEvent,
} from '@opspilot/application';

import type { EvalRunResult } from '../core/eval-run-result.js';
import type { EvalScore } from '../core/eval-score.js';
import type { Evaluator } from '../core/evaluator.js';
import type { ExcelGoldenWorkbookMutationExpected } from '../datasets/excel-dataset-loader.js';
import type { DurableTurnReader } from './durable-turn-evidence.js';

const EVALUATOR_NAME = 'verify_after_write';

interface A1Range {
  readonly startRow: number;
  readonly endRow: number;
  readonly startColumn: number;
  readonly endColumn: number;
}

interface ToolRangeObservation {
  readonly event: ToolCompletedEvent;
  readonly sheetName: string;
  readonly range: string;
  readonly coordinates: A1Range;
}

export interface VerifyAfterWriteEvaluatorOptions {
  readonly turns: DurableTurnReader;
}

/** Verifies that a successful target write is followed by a durable covering read. */
export class VerifyAfterWriteEvaluator implements Evaluator<unknown, ExecuteTurnResult> {
  public readonly name = EVALUATOR_NAME;

  private readonly turns: DurableTurnReader;

  /** Creates a behavior evaluator over the durable Turn event reader. */
  public constructor(options: VerifyAfterWriteEvaluatorOptions) {
    this.turns = options.turns;
  }

  /** Evaluates write-then-read behavior without inspecting transient execution messages. */
  public async evaluate(input: {
    readonly expected: unknown;
    readonly actual: ExecuteTurnResult | undefined;
    readonly run: EvalRunResult<ExecuteTurnResult>;
  }): Promise<EvalScore> {
    if (!shouldVerifyAfterWrite(input.expected)) {
      return pass({ kind: 'skipped', reason: 'verifyAfterWrite is not enabled.' });
    }

    const expected = readExpectedWorkbookMutation(input.expected);
    if (expected === undefined) {
      return fail('expected.workbookMutation is invalid.', {
        kind: 'invalid_expected_contract',
      });
    }

    const expectedCoordinates = parseA1Range(expected.range);
    const turnId = readNonEmptyString(input.run.metadata?.turnId);
    const details: Record<string, unknown> = {
      evidenceSource: 'durable',
      turnId: turnId ?? null,
      writeCallId: null,
      writeSequence: null,
      writeSheetName: expected.sheetName,
      writeRange: expected.range,
      readCallId: null,
      readSequence: null,
      readSheetName: null,
      readRange: null,
    };

    if (expectedCoordinates === undefined) {
      return fail('expected.workbookMutation.range must be a supported A1 range.', {
        ...details,
        kind: 'invalid_expected_contract',
      });
    }
    if (turnId === undefined) {
      return fail('Eval run did not expose a valid turnId for verify-after-write evaluation.', {
        ...details,
        kind: 'missing_target_write',
      });
    }

    let turn: Turn;
    let events: readonly TurnEvent[];
    try {
      turn = this.turns.load(turnId);
      if (turn.getId() !== turnId) {
        return fail(`Durable Turn reader returned ${turn.getId()} while loading ${turnId}.`, {
          ...details,
          kind: 'missing_target_write',
        });
      }
      events = this.turns.loadEvents(turnId);
    } catch (error: unknown) {
      return fail(`Unable to load durable write/read evidence: ${errorMessage(error)}`, {
        ...details,
        kind: 'missing_target_write',
      });
    }

    const matchingWrites = events
      .filter(isTurnToolCompletedFor(turnId, turn.getSessionId(), 'write_data'))
      .filter((event) => !event.isError)
      .map(toToolRangeObservation)
      .filter(
        (observation): observation is ToolRangeObservation =>
          observation !== undefined &&
          observation.sheetName === expected.sheetName &&
          rangesEqual(observation.coordinates, expectedCoordinates),
      );
    const targetWrite = latestBySequence(matchingWrites);
    if (targetWrite === undefined) {
      return fail('No successful write_data matched the expected workbook mutation target.', {
        ...details,
        kind: 'missing_target_write',
      });
    }

    details.writeCallId = targetWrite.event.callId;
    details.writeSequence = targetWrite.event.sequence;
    details.writeSheetName = targetWrite.sheetName;
    details.writeRange = targetWrite.range;

    const readsAfterWrite = events
      .filter(isTurnToolCompletedFor(turnId, turn.getSessionId(), 'read_range'))
      .filter((event) => event.sequence > targetWrite.event.sequence);
    const successfulReads = readsAfterWrite.filter((event) => !event.isError);
    const matchingRead = successfulReads
      .map(toToolRangeObservation)
      .find(
        (observation) =>
          observation !== undefined &&
          observation.sheetName === expected.sheetName &&
          covers(observation.coordinates, targetWrite.coordinates),
      );

    if (matchingRead !== undefined) {
      details.readCallId = matchingRead.event.callId;
      details.readSequence = matchingRead.event.sequence;
      details.readSheetName = matchingRead.sheetName;
      details.readRange = matchingRead.range;
      return pass(details);
    }

    if (successfulReads.length > 0) {
      return fail('No successful read_range covered the target write range.', {
        ...details,
        kind: 'verification_range_mismatch',
      });
    }
    if (readsAfterWrite.some((event) => event.isError)) {
      return fail('All read_range attempts after the target write failed.', {
        ...details,
        kind: 'verification_read_failed',
      });
    }
    return fail('No read_range completed after the target write.', {
      ...details,
      kind: 'missing_verification_read',
    });
  }
}

/** Checks the opt-in behavior flag without assuming the dataset loader ran first. */
function shouldVerifyAfterWrite(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.behavior)) return false;
  return value.behavior.verifyAfterWrite === true;
}

/** Reads the mutation target defensively at the evaluator boundary. */
function readExpectedWorkbookMutation(
  value: unknown,
): ExcelGoldenWorkbookMutationExpected | undefined {
  const candidate = isRecord(value) ? value.workbookMutation : undefined;
  if (!isRecord(candidate)) return undefined;

  const sheetName = readNonEmptyString(candidate.sheetName);
  const range = readNonEmptyString(candidate.range);
  const expectedValues = readRectangularMatrix(candidate.expectedValues);
  if (sheetName === undefined || range === undefined || expectedValues === undefined) {
    return undefined;
  }

  return { sheetName, range, expectedValues };
}

/** Reads only the matrix shape needed to recognize a valid mutation contract. */
function readRectangularMatrix(value: unknown): readonly (readonly unknown[])[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;

  const rows: (readonly unknown[])[] = [];
  let columnCount: number | undefined;
  for (const candidateRow of value) {
    if (!Array.isArray(candidateRow) || candidateRow.length === 0) return undefined;
    if (columnCount === undefined) columnCount = candidateRow.length;
    if (candidateRow.length !== columnCount) return undefined;
    rows.push([...candidateRow]);
  }
  return rows;
}

/** Narrows a durable tool completion to one named tool in the current Turn. */
function isTurnToolCompletedFor(
  turnId: string,
  sessionId: string,
  name: string,
): (event: TurnEvent) => event is ToolCompletedEvent {
  return (event): event is ToolCompletedEvent =>
    event.type === 'tool_completed' &&
    event.turnId === turnId &&
    event.sessionId === sessionId &&
    event.name === name;
}

/** Reads the durable sheet/range receipt emitted by an Excel tool. */
function toToolRangeObservation(event: ToolCompletedEvent): ToolRangeObservation | undefined {
  if (!isRecord(event.resultDetails)) return undefined;
  const sheetName = readNonEmptyString(event.resultDetails.sheetName);
  const range = readNonEmptyString(event.resultDetails.range);
  const coordinates = range === undefined ? undefined : parseA1Range(range);
  if (sheetName === undefined || range === undefined || coordinates === undefined) return undefined;
  return { event, sheetName, range, coordinates };
}

/** Returns the last matching successful write using durable sequence, not timestamps. */
function latestBySequence(
  observations: readonly ToolRangeObservation[],
): ToolRangeObservation | undefined {
  return observations.reduce<ToolRangeObservation | undefined>(
    (latest, observation) =>
      latest === undefined || observation.event.sequence > latest.event.sequence
        ? observation
        : latest,
    undefined,
  );
}

/** Checks exact target correspondence after normalizing A1 case and coordinates. */
function rangesEqual(left: A1Range, right: A1Range): boolean {
  return (
    left.startRow === right.startRow &&
    left.endRow === right.endRow &&
    left.startColumn === right.startColumn &&
    left.endColumn === right.endColumn
  );
}

/** Checks whether a read rectangle fully contains the written rectangle. */
function covers(read: A1Range, written: A1Range): boolean {
  return (
    read.startRow <= written.startRow &&
    read.endRow >= written.endRow &&
    read.startColumn <= written.startColumn &&
    read.endColumn >= written.endColumn
  );
}

/** Parses the deliberately small A1 range subset needed by this evaluator. */
function parseA1Range(value: string): A1Range | undefined {
  const match = /^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/.exec(value.trim());
  if (match === null) return undefined;

  const startColumn = parseColumn(match[1]);
  const startRow = parsePositiveSafeInteger(match[2]);
  const endColumn = parseColumn(match[3] ?? match[1]);
  const endRow = parsePositiveSafeInteger(match[4] ?? match[2]);
  if (
    startColumn === undefined ||
    startRow === undefined ||
    endColumn === undefined ||
    endRow === undefined ||
    endRow < startRow ||
    endColumn < startColumn
  ) {
    return undefined;
  }

  return { startRow, endRow, startColumn, endColumn };
}

/** Converts an Excel column label to a one-based column number. */
function parseColumn(value: string): number | undefined {
  let column = 0;
  for (const character of value.toUpperCase()) {
    const digit = character.charCodeAt(0) - 64;
    if (digit < 1 || digit > 26 || column > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 26)) {
      return undefined;
    }
    column = column * 26 + digit;
  }
  return column > 0 ? column : undefined;
}

/** Parses a positive safe integer from an A1 row component. */
function parsePositiveSafeInteger(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Reads a non-blank string from a durable or dataset boundary. */
function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/** Narrows unknown JSON-shaped values without weakening strict TypeScript checks. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Converts an unknown thrown value into a stable evaluator diagnostic. */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/** Creates a passing score with deterministic diagnostic details. */
function pass(details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: EVALUATOR_NAME, score: 1, passed: true, details };
}

/** Creates a failing score with a machine-readable failure kind. */
function fail(reason: string, details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: EVALUATOR_NAME, score: 0, passed: false, reason, details };
}
