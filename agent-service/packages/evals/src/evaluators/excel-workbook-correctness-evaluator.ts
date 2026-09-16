import type { AssistantMessage, ToolResultMessage } from '@opspilot/model-gateway';
import type { ExecuteTurnResult } from '@opspilot/application';

import type { EvalRunResult } from '../core/eval-run-result.js';
import type { EvalScore } from '../core/eval-score.js';
import type { Evaluator } from '../core/evaluator.js';

/** Deterministically checks both the real workbook tool result and the final answer. */
export class ExcelWorkbookCorrectnessEvaluator implements Evaluator<unknown, ExecuteTurnResult> {
  public readonly name = 'excel_workbook_correctness';

  /** Returns a binary score for the supported fixed sheet-count Golden Case contract. */
  public async evaluate(input: {
    readonly expected: unknown;
    readonly actual: ExecuteTurnResult | undefined;
    readonly run: EvalRunResult<ExecuteTurnResult>;
  }): Promise<EvalScore> {
    const expectedSheetCount = readExpectedSheetCount(input.expected);
    const details: Record<string, unknown> = {
      expectedSheetCount,
      actualToolSheetCount: null,
    };

    if (!isValidSheetCount(expectedSheetCount)) {
      return fail('expected.sheetCount must be an integer >= 0.', details);
    }
    if (input.actual === undefined) {
      return fail(
        input.run.error?.message ?? 'Application execution did not produce a result.',
        details,
      );
    }

    const toolResult = findSuccessfulWorkbookInfo(input.actual);
    if (toolResult === undefined) {
      return fail(
        hasWorkbookInfoToolResult(input.actual)
          ? 'get_workbook_info tool execution failed.'
          : 'get_workbook_info was not executed.',
        details,
      );
    }

    const actualToolSheetCount = readSheetCount(toolResult.details);
    details.actualToolSheetCount = actualToolSheetCount;
    if (actualToolSheetCount === undefined) {
      return fail('get_workbook_info returned invalid sheetCount details.', details);
    }
    if (actualToolSheetCount !== expectedSheetCount) {
      return fail(
        `Expected sheetCount ${expectedSheetCount} but tool returned ${actualToolSheetCount}.`,
        details,
      );
    }

    const assistant = findLastSuccessfulAssistant(input.actual);
    if (assistant === undefined) {
      return fail('No successful final assistant answer was produced.', details);
    }
    const answer = assistant.content
      .filter(
        (content): content is Extract<AssistantMessage['content'][number], { type: 'text' }> =>
          content.type === 'text',
      )
      .map((content) => content.text)
      .join('\n');
    if (!containsInteger(answer, expectedSheetCount)) {
      return fail(
        `The workbook tool returned the correct sheet count, but the final assistant answer did not contain the expected value ${expectedSheetCount}.`,
        details,
      );
    }

    return {
      evaluator: this.name,
      score: 1,
      passed: true,
      details,
    };
  }
}

/** Finds the last successful get_workbook_info result, ignoring failed tool attempts. */
function findSuccessfulWorkbookInfo(result: ExecuteTurnResult): ToolResultMessage | undefined {
  return [...result.messages]
    .reverse()
    .find(
      (message): message is ToolResultMessage =>
        message.role === 'tool' && message.name === 'get_workbook_info' && message.isError !== true,
    );
}

/** Distinguishes a missing tool call from a tool call that returned an error. */
function hasWorkbookInfoToolResult(result: ExecuteTurnResult): boolean {
  return result.messages.some(
    (message): message is ToolResultMessage =>
      message.role === 'tool' && message.name === 'get_workbook_info',
  );
}

/** Finds the final assistant response that completed normally. */
function findLastSuccessfulAssistant(result: ExecuteTurnResult): AssistantMessage | undefined {
  return [...result.messages]
    .reverse()
    .find(
      (message): message is AssistantMessage =>
        message.role === 'assistant' && message.finishReason === 'stop',
    );
}

/** Reads the structured tool fact without trusting tool-call arguments or display text. */
function readSheetCount(details: unknown): number | undefined {
  if (!isRecord(details) || !isValidSheetCount(details.sheetCount)) return undefined;
  return details.sheetCount;
}

/** Checks the fixed numeric contract shared by Golden expected and tool result. */
function isValidSheetCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Reads the only supported Golden expected field without trusting generic Eval input. */
function readExpectedSheetCount(value: unknown): number | undefined {
  const sheetCount = isRecord(value) ? value.sheetCount : undefined;
  return isValidSheetCount(sheetCount) ? sheetCount : undefined;
}

/** Checks for a standalone Arabic integer token, avoiding partial matches such as 30 for 3. */
function containsInteger(text: string, expected: number): boolean {
  const token = String(expected);
  let searchFrom = 0;
  while (true) {
    const index = text.indexOf(token, searchFrom);
    if (index < 0) return false;
    const before = index === 0 ? '' : text[index - 1];
    const after = text[index + token.length] ?? '';
    if (!isAsciiDigit(before) && !isAsciiDigit(after)) return true;
    searchFrom = index + token.length;
  }
}

/** Checks an ASCII digit boundary for deterministic answer matching. */
function isAsciiDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

/** Creates the normalized binary failure score used by this evaluator. */
function fail(reason: string, details: Readonly<Record<string, unknown>>): EvalScore {
  return {
    evaluator: 'excel_workbook_correctness',
    score: 0,
    passed: false,
    reason,
    details,
  };
}

/** Checks an unknown details payload without weakening the evaluator contract. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
