import type { ExecuteTurnResult, ToolCompletedEvent, Turn, TurnEvent } from '@opspilot/application';

import type { EvalRunResult } from '../core/eval-run-result.js';
import type { EvalScore } from '../core/eval-score.js';
import type { Evaluator } from '../core/evaluator.js';
import type { ExcelGoldenWorkbookMutationExpected } from '../datasets/excel-dataset-loader.js';
import type { DurableTurnReader } from './durable-turn-evidence.js';

const EVALUATOR_NAME = 'workbook_mutation';

/** Reads a committed working workbook without coupling Eval code to an Excel implementation. */
export interface WorkbookMutationReader {
  readRange(input: {
    readonly sessionId: string;
    readonly resourceId: string;
    readonly sheetName: string;
    readonly range: string;
  }): Promise<readonly (readonly unknown[])[] | null>;
}

/** Dependencies for deterministic workbook mutation outcome evaluation. */
export interface WorkbookMutationEvaluatorOptions {
  readonly turns: DurableTurnReader;
  readonly workbook: WorkbookMutationReader;
}

/** Verifies both durable write evidence and the resulting working workbook artifact. */
export class WorkbookMutationEvaluator implements Evaluator<unknown, ExecuteTurnResult> {
  public readonly name = EVALUATOR_NAME;

  private readonly turns: DurableTurnReader;
  private readonly workbook: WorkbookMutationReader;

  /** Creates an evaluator that reads durable Turn events and a composed workbook reader. */
  public constructor(options: WorkbookMutationEvaluatorOptions) {
    this.turns = options.turns;
    this.workbook = options.workbook;
  }

  /** Returns pass for non-mutation cases and a binary outcome score for mutation cases. */
  public async evaluate(input: {
    readonly expected: unknown;
    readonly actual: ExecuteTurnResult | undefined;
    readonly run: EvalRunResult<ExecuteTurnResult>;
  }): Promise<EvalScore> {
    const expected = readExpectedWorkbookMutation(input.expected);
    if (expected === undefined && !hasWorkbookMutationExpectation(input.expected)) {
      return pass({ kind: 'skipped', reason: 'No workbookMutation expectation.' });
    }
    if (expected === undefined) {
      return fail('expected.workbookMutation is invalid.', {
        kind: 'invalid_expected_contract',
      });
    }

    const turnId = readNonEmptyString(input.run.metadata?.turnId);
    const details: Record<string, unknown> = {
      evidenceSource: 'durable',
      turnId: turnId ?? null,
      sheetName: expected.sheetName,
      range: expected.range,
      expectedValues: expected.expectedValues,
      actualValues: null,
      writeCallId: null,
    };
    if (turnId === undefined) {
      return fail('Eval run did not expose a valid turnId for workbook mutation evaluation.', {
        ...details,
        kind: 'missing_write_tool',
      });
    }

    let turn: Turn;
    let events: readonly TurnEvent[];
    try {
      turn = this.turns.load(turnId);
      if (turn.getId() !== turnId) {
        return fail(`Durable Turn reader returned ${turn.getId()} while loading ${turnId}.`, {
          ...details,
          kind: 'missing_write_tool',
        });
      }
      events = this.turns.loadEvents(turnId);
    } catch (error: unknown) {
      return fail(`Unable to load durable write evidence: ${errorMessage(error)}`, {
        ...details,
        kind: 'missing_write_tool',
      });
    }

    const writeAttempts = events.filter(
      (event): event is ToolCompletedEvent =>
        event.type === 'tool_completed' &&
        event.turnId === turnId &&
        event.sessionId === turn.getSessionId() &&
        event.name === 'write_data',
    );
    if (writeAttempts.length === 0) {
      return fail('write_data was not completed in durable Turn evidence.', {
        ...details,
        kind: 'missing_write_tool',
      });
    }

    const successfulWrite = [...writeAttempts].reverse().find((event) => !event.isError);
    if (successfulWrite === undefined) {
      return fail('All durable write_data completions were errors.', {
        ...details,
        kind: 'write_tool_failed',
      });
    }
    details.writeCallId = successfulWrite.callId;

    const resourceId = readNonEmptyString(input.run.metadata?.excelResourceId);
    if (resourceId === undefined) {
      return fail('Eval run did not expose the Excel working resource identity.', {
        ...details,
        kind: 'missing_working_resource',
      });
    }

    let actualValues: readonly (readonly unknown[])[] | null;
    try {
      actualValues = await this.workbook.readRange({
        sessionId: turn.getSessionId(),
        resourceId,
        sheetName: expected.sheetName,
        range: expected.range,
      });
    } catch (error: unknown) {
      return fail(`Unable to read the final working workbook: ${errorMessage(error)}`, {
        ...details,
        kind: 'workbook_read_failed',
      });
    }
    if (actualValues === null) {
      return fail('The Eval run has no committed working workbook for the Excel resource.', {
        ...details,
        kind: 'missing_working_resource',
      });
    }

    details.actualValues = actualValues;
    if (!matrixEquals(expected.expectedValues, actualValues)) {
      return fail('The final working workbook values did not match expectedValues.', {
        ...details,
        kind: 'value_mismatch',
      });
    }

    return pass(details);
  }
}

/** Reads the mutation contract while keeping the evaluator boundary typed as unknown. */
function readExpectedWorkbookMutation(
  value: unknown,
): ExcelGoldenWorkbookMutationExpected | undefined {
  const candidate = isRecord(value) ? value.workbookMutation : undefined;
  const sheetName = isRecord(candidate) ? readNonEmptyString(candidate.sheetName) : undefined;
  const range = isRecord(candidate) ? readNonEmptyString(candidate.range) : undefined;
  if (
    !isRecord(candidate) ||
    sheetName === undefined ||
    range === undefined ||
    !Array.isArray(candidate.expectedValues) ||
    candidate.expectedValues.length === 0 ||
    !candidate.expectedValues.every((row) => Array.isArray(row))
  ) {
    return undefined;
  }
  return {
    sheetName,
    range,
    expectedValues: candidate.expectedValues,
  };
}

/** Distinguishes a skipped case from an explicitly malformed mutation expectation. */
function hasWorkbookMutationExpectation(value: unknown): boolean {
  return isRecord(value) && value.workbookMutation !== undefined;
}

/** Compares the expected and actual rectangular values without relying on ExcelJS internals. */
function matrixEquals(
  expected: readonly (readonly unknown[])[],
  actual: readonly (readonly unknown[])[],
): boolean {
  if (expected.length !== actual.length) return false;
  return expected.every((expectedRow, rowIndex) => {
    const actualRow = actual[rowIndex];
    return (
      actualRow !== undefined &&
      expectedRow.length === actualRow.length &&
      expectedRow.every((expectedValue, columnIndex) =>
        valuesEqual(expectedValue, actualRow[columnIndex]),
      )
    );
  });
}

/** Compares scalar, Date, array, and record values deterministically. */
function valuesEqual(expected: unknown, actual: unknown): boolean {
  if (Object.is(expected, actual)) return true;
  if (expected instanceof Date || actual instanceof Date) {
    return (
      expected instanceof Date && actual instanceof Date && expected.getTime() === actual.getTime()
    );
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      return false;
    }
    return expected.every((value, index) => valuesEqual(value, actual[index]));
  }
  if (isRecord(expected) || isRecord(actual)) {
    if (!isRecord(expected) || !isRecord(actual)) return false;
    const expectedKeys = Object.keys(expected);
    const actualKeys = Object.keys(actual);
    return (
      expectedKeys.length === actualKeys.length &&
      expectedKeys.every(
        (key) => Object.hasOwn(actual, key) && valuesEqual(expected[key], actual[key]),
      )
    );
  }
  return false;
}

/** Creates a passing score with deterministic diagnostic details. */
function pass(details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: EVALUATOR_NAME, score: 1, passed: true, details };
}

/** Creates a failing score with a machine-readable failure kind. */
function fail(reason: string, details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: EVALUATOR_NAME, score: 0, passed: false, reason, details };
}

/** Reads a non-empty string from an untrusted metadata or dataset boundary. */
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
