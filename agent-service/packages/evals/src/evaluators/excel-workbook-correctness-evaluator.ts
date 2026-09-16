import type { AssistantMessage, ToolResultMessage } from '@opspilot/model-gateway';
import type { ExecuteTurnResult } from '@opspilot/application';

import type { EvalRunResult } from '../core/eval-run-result.js';
import type { EvalScore } from '../core/eval-score.js';
import type { Evaluator } from '../core/evaluator.js';
import type {
  ExcelGoldenSheetRowsExpected,
  ExcelGoldenTopRegionSalesExpected,
} from '../datasets/excel-dataset-loader.js';

const REGIONAL_SALES_COLUMNS = {
  group: 'Region',
  sales: 'Revenue',
  orderId: 'OrderID',
} as const;
const SALES_COMPARISON_TOLERANCE = 0.01;

/** Deterministically checks both the real workbook tool result and the final answer. */
export class ExcelWorkbookCorrectnessEvaluator implements Evaluator<unknown, ExecuteTurnResult> {
  public readonly name = 'excel_workbook_correctness';

  /** Returns a binary score for the supported deterministic Excel Golden contracts. */
  public async evaluate(input: {
    readonly expected: unknown;
    readonly actual: ExecuteTurnResult | undefined;
    readonly run: EvalRunResult<ExecuteTurnResult>;
  }): Promise<EvalScore> {
    if (hasExpectedTopRegionSales(input.expected)) {
      return evaluateTopRegionSales(input);
    }
    if (hasExpectedSheetRows(input.expected)) {
      return evaluateSheetRows(input);
    }

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

/** Evaluates the regional sales aggregate and the final assistant answer. */
async function evaluateTopRegionSales(input: {
  readonly expected: unknown;
  readonly actual: ExecuteTurnResult | undefined;
  readonly run: EvalRunResult<ExecuteTurnResult>;
}): Promise<EvalScore> {
  const expected = readExpectedTopRegionSales(input.expected);
  const details: Record<string, unknown> = {
    sheetName: expected?.sheetName ?? null,
    expectedRegion: expected?.region ?? null,
    actualRegion: null,
    expectedTotalSales: expected?.totalSales ?? null,
    actualTotalSales: null,
    expectedOrderCount: expected?.orderCount ?? null,
    actualOrderCount: null,
    highestSalesVerified: false,
  };

  if (expected === undefined) {
    return fail('expected.topRegionSales is invalid.', details);
  }
  if (input.actual === undefined) {
    return fail(
      input.run.error?.message ?? 'Application execution did not produce a result.',
      details,
    );
  }

  const aggregateAttempts = findAggregateDataMessages(input.actual);
  if (aggregateAttempts.length === 0) {
    return fail('aggregate_data was not executed.', details);
  }
  const successfulAttempts = aggregateAttempts.filter((message) => message.isError !== true);
  if (successfulAttempts.length === 0) {
    return fail('aggregate_data tool execution failed.', details);
  }

  const aggregateCandidates = successfulAttempts
    .map((message) => readRegionalSalesAggregate(message.details, expected.sheetName))
    .filter((candidate): candidate is RegionalSalesAggregate => candidate !== undefined);
  const aggregate = [...aggregateCandidates]
    .reverse()
    .find(
      (candidate) =>
        !candidate.truncated &&
        candidate.rows.length >= candidate.resultRowCount &&
        candidate.returnedRowCount >= candidate.resultRowCount,
    ) ?? aggregateCandidates.at(-1);
  if (aggregate === undefined) {
    return fail(
      `No aggregate_data result for ${expected.sheetName} contained the required regional sales aggregation.`,
      details,
    );
  }

  if (
    aggregate.truncated ||
    aggregate.rows.length < aggregate.resultRowCount ||
    aggregate.returnedRowCount < aggregate.resultRowCount
  ) {
    return fail(
      'aggregate_data result was truncated, so the highest-sales region cannot be verified deterministically.',
      details,
    );
  }

  const regionalRows = aggregate.rows.filter(
    (row) => row[aggregate.groupIndex] === expected.region,
  );
  if (regionalRows.length === 0) {
    return fail(`Expected top region ${expected.region} was not present in aggregate_data rows.`, details);
  }
  if (regionalRows.length > 1) {
    return fail(`Aggregate data returned multiple rows for region ${expected.region}.`, details);
  }

  const expectedRegionRow = regionalRows[0]!;
  const actualTotalSales = expectedRegionRow[aggregate.salesIndex];
  const actualOrderCount = expectedRegionRow[aggregate.orderCountIndex];
  details.actualTotalSales = actualTotalSales;
  details.actualOrderCount = actualOrderCount;

  if (!isFiniteNumber(actualTotalSales)) {
    return fail(`Expected ${expected.region} to have a numeric sales total.`, details);
  }
  if (!isNonNegativeInteger(actualOrderCount)) {
    return fail(`Expected ${expected.region} to have an integer order count.`, details);
  }
  if (!approximatelyEqual(actualTotalSales, expected.totalSales)) {
    return fail(
      `Expected ${expected.region} total sales ${formatNumber(expected.totalSales)} but aggregate_data returned ${formatNumber(actualTotalSales)}.`,
      details,
    );
  }
  if (actualOrderCount !== expected.orderCount) {
    return fail(
      `Expected ${expected.region} order count ${expected.orderCount} but aggregate_data returned ${actualOrderCount}.`,
      details,
    );
  }

  const salesByRow = aggregate.rows.map((row) => row[aggregate.salesIndex]);
  if (salesByRow.length === 0) {
    return fail('aggregate_data returned no regional rows.', details);
  }
  if (!salesByRow.every(isFiniteNumber)) {
    return fail('aggregate_data returned an invalid sales sum for at least one region.', details);
  }
  const maximumSales = Math.max(...salesByRow);
  const highestRow = aggregate.rows[salesByRow.indexOf(maximumSales)];
  const actualRegion = formatAggregateValue(highestRow?.[aggregate.groupIndex]);
  details.actualRegion = actualRegion;
  const highestSalesVerified = approximatelyEqual(actualTotalSales, maximumSales);
  details.highestSalesVerified = highestSalesVerified;
  if (!highestSalesVerified) {
    return fail(
      `${expected.region} had the expected sales total, but another region had a higher total.`,
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
    .join(' ');
  if (!containsTopRegionSalesAnswer(answer, expected)) {
    return fail(
      'The aggregate result was correct, but the final assistant answer did not report the expected top region and metrics together.',
      details,
    );
  }

  return {
    evaluator: 'excel_workbook_correctness',
    score: 1,
    passed: true,
    details,
  };
}

interface RegionalSalesAggregate {
  readonly columns: readonly AggregateColumnMetadata[];
  readonly rows: readonly (readonly unknown[])[];
  readonly groupIndex: number;
  readonly salesIndex: number;
  readonly orderCountIndex: number;
  readonly resultRowCount: number;
  readonly returnedRowCount: number;
  readonly truncated: boolean;
}

interface AggregateColumnMetadata {
  readonly kind: 'group' | 'metric';
  readonly sourceColumn: string;
  readonly operation?: string;
}

/** Finds all aggregate_data messages so a valid later attempt can supersede an invalid one. */
function findAggregateDataMessages(result: ExecuteTurnResult): readonly ToolResultMessage[] {
  return result.messages.filter(
    (message): message is ToolResultMessage =>
      message.role === 'tool' && message.name === 'aggregate_data',
  );
}

/** Reads aggregate metadata without trusting aliases or display text. */
function readRegionalSalesAggregate(
  details: unknown,
  expectedSheetName: string,
): RegionalSalesAggregate | undefined {
  if (
    !isRecord(details) ||
    details.sheetName !== expectedSheetName ||
    !Array.isArray(details.columns) ||
    !Array.isArray(details.rows) ||
    typeof details.truncated !== 'boolean' ||
    !isNonNegativeInteger(details.resultRowCount) ||
    !isNonNegativeInteger(details.returnedRowCount) ||
    !details.rows.every((row): row is readonly unknown[] => Array.isArray(row))
  ) {
    return undefined;
  }

  const columns = details.columns
    .map(readAggregateColumnMetadata)
    .filter((column): column is AggregateColumnMetadata => column !== undefined);
  if (columns.length !== details.columns.length) return undefined;

  const groupIndex = columns.findIndex(
    (column) =>
      column.kind === 'group' && column.sourceColumn === REGIONAL_SALES_COLUMNS.group,
  );
  const salesIndex = columns.findIndex(
    (column) =>
      column.kind === 'metric' &&
      column.sourceColumn === REGIONAL_SALES_COLUMNS.sales &&
      column.operation === 'sum',
  );
  const orderCountIndex = columns.findIndex(
    (column) =>
      column.kind === 'metric' &&
      column.sourceColumn === REGIONAL_SALES_COLUMNS.orderId &&
      column.operation === 'count',
  );
  if (groupIndex < 0 || salesIndex < 0 || orderCountIndex < 0) return undefined;

  return {
    columns,
    rows: details.rows,
    groupIndex,
    salesIndex,
    orderCountIndex,
    resultRowCount: details.resultRowCount,
    returnedRowCount: details.returnedRowCount,
    truncated: details.truncated,
  };
}

/** Narrows one structured aggregate column while leaving aliases unconstrained. */
function readAggregateColumnMetadata(value: unknown): AggregateColumnMetadata | undefined {
  if (
    !isRecord(value) ||
    (value.kind !== 'group' && value.kind !== 'metric') ||
    typeof value.sourceColumn !== 'string' ||
    value.sourceColumn.trim().length === 0
  ) {
    return undefined;
  }
  return {
    kind: value.kind,
    sourceColumn: value.sourceColumn,
    ...(typeof value.operation === 'string' ? { operation: value.operation } : {}),
  };
}

/** Reads and validates the fixed Case 3 expected contract. */
function readExpectedTopRegionSales(
  value: unknown,
): ExcelGoldenTopRegionSalesExpected | undefined {
  const candidate = isRecord(value) ? value.topRegionSales : undefined;
  if (
    !isRecord(candidate) ||
    typeof candidate.sheetName !== 'string' ||
    candidate.sheetName.trim().length === 0 ||
    typeof candidate.region !== 'string' ||
    candidate.region.trim().length === 0 ||
    !isFiniteNumber(candidate.totalSales) ||
    !isNonNegativeInteger(candidate.orderCount)
  ) {
    return undefined;
  }
  return {
    sheetName: candidate.sheetName,
    region: candidate.region,
    totalSales: candidate.totalSales,
    orderCount: candidate.orderCount,
  };
}

/** Distinguishes Case 3's expected contract from the existing discovery contracts. */
function hasExpectedTopRegionSales(value: unknown): boolean {
  return isRecord(value) && value.topRegionSales !== undefined;
}

/** Checks a finite numeric value from structured aggregate details. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Checks a non-negative integer from structured aggregate details. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Matches the expected facts in one answer clause so metrics cannot be detached from the region. */
function containsTopRegionSalesAnswer(
  answer: string,
  expected: ExcelGoldenTopRegionSalesExpected,
): boolean {
  const clauses = answer.split(/[\r\n。!！？?；;]+|\.(?!\d)/u);
  return clauses.some((clause) => {
    if (!containsTextToken(clause, expected.region)) return false;
    if (!containsAmountToken(clause, expected.totalSales)) return false;
    return (
      containsOrderCountToken(clause, expected.orderCount) ||
      containsCompactAggregateCount(clause, expected.totalSales, expected.orderCount)
    );
  });
}

/** Matches one region label without accepting it as a substring of another identifier. */
function containsTextToken(text: string, expected: string): boolean {
  const normalizedText = text.toLocaleLowerCase();
  const normalizedExpected = expected.toLocaleLowerCase();
  let searchFrom = 0;
  while (true) {
    const index = normalizedText.indexOf(normalizedExpected, searchFrom);
    if (index < 0) return false;
    const before = index === 0 ? '' : normalizedText[index - 1]!;
    const after = normalizedText[index + normalizedExpected.length] ?? '';
    if (!isAsciiWordCharacter(before) && !isAsciiWordCharacter(after)) return true;
    searchFrom = index + normalizedExpected.length;
  }
}

/** Matches a formatted amount after removing only thousands separators. */
function containsAmountToken(text: string, expected: number): boolean {
  const normalized = text.replaceAll(',', '');
  const numericTokens = normalized.match(/\d+(?:\.\d+)?/gu) ?? [];
  return numericTokens.some((token) => {
    const value = Number(token);
    return Number.isFinite(value) && approximatelyEqual(value, expected);
  });
}

/** Matches the order count and requires nearby order-count semantics. */
function containsOrderCountToken(text: string, expected: number): boolean {
  const token = String(expected);
  let searchFrom = 0;
  while (true) {
    const index = text.indexOf(token, searchFrom);
    if (index < 0) return false;
    const before = index === 0 ? '' : text[index - 1]!;
    const after = text[index + token.length] ?? '';
    if (!isAsciiDigit(before) && !isAsciiDigit(after)) {
      const nearby = text.slice(Math.max(0, index - 24), index + token.length + 24);
      if (/(?:order|订单|笔)/iu.test(nearby)) return true;
    }
    searchFrom = index + token.length;
  }
}

/** Accepts a compact `region / sales / count` answer while keeping all facts in one clause. */
function containsCompactAggregateCount(
  text: string,
  expectedSales: number,
  expectedOrderCount: number,
): boolean {
  const numericTokens = (text.replaceAll(',', '').match(/\d+(?:\.\d+)?/gu) ?? []).map(Number);
  return (
    numericTokens.length === 2 &&
    numericTokens.some((value) => approximatelyEqual(value, expectedSales)) &&
    numericTokens.some((value) => value === expectedOrderCount)
  );
}

/** Checks a small deterministic tolerance for currency floating-point representation. */
function approximatelyEqual(actual: number, expected: number): boolean {
  return Math.abs(actual - expected) <= SALES_COMPARISON_TOLERANCE;
}

/** Formats numeric failure details consistently without changing the fixed expected value. */
function formatNumber(value: number): string {
  return value.toFixed(2);
}

/** Formats a structured group value for diagnostic details. */
function formatAggregateValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

/** Checks whether a character can be part of an ASCII identifier. */
function isAsciiWordCharacter(value: string): boolean {
  return /^[A-Za-z0-9_]$/u.test(value);
}

/** Evaluates every expected worksheet using successful structured profile results and the final answer. */
async function evaluateSheetRows(input: {
  readonly expected: unknown;
  readonly actual: ExecuteTurnResult | undefined;
  readonly run: EvalRunResult<ExecuteTurnResult>;
}): Promise<EvalScore> {
  const expectedSheetRows = readExpectedSheetRows(input.expected);
  const details: Record<string, unknown> = {
    sheets:
      expectedSheetRows?.map((sheet) => ({
        sheetName: sheet.sheetName,
        expectedDataRowCount: sheet.dataRowCount,
        expectedHeaderRowCount: sheet.headerRowCount,
        actualToolRowCount: null,
        actualDataRowCount: null,
      })) ?? [],
  };

  if (expectedSheetRows === undefined) {
    return fail(
      'expected.sheetRows must be a non-empty array of valid worksheet row expectations.',
      details,
    );
  }
  if (input.actual === undefined) {
    return fail(
      input.run.error?.message ?? 'Application execution did not produce a result.',
      details,
    );
  }

  const successfulProfiles = findSuccessfulSheetProfiles(input.actual);
  const detailSheets = details.sheets as Array<Record<string, unknown>>;
  for (let index = 0; index < expectedSheetRows.length; index += 1) {
    const expectedSheet = expectedSheetRows[index]!;
    const profile = [...successfulProfiles]
      .reverse()
      .find(
        (candidate) =>
          readSheetProfileDetails(candidate.details)?.sheetName === expectedSheet.sheetName,
      );
    if (profile === undefined) {
      return fail(
        `No successful get_sheet_profile result was found for ${expectedSheet.sheetName}.`,
        details,
      );
    }

    const actualProfile = readSheetProfileDetails(profile.details);
    if (actualProfile === undefined) {
      return fail(
        `get_sheet_profile returned invalid details for ${expectedSheet.sheetName}.`,
        details,
      );
    }
    const actualDataRowCount = actualProfile.rowCount - expectedSheet.headerRowCount;
    detailSheets[index] = {
      sheetName: expectedSheet.sheetName,
      expectedDataRowCount: expectedSheet.dataRowCount,
      expectedHeaderRowCount: expectedSheet.headerRowCount,
      actualToolRowCount: actualProfile.rowCount,
      actualDataRowCount,
    };
    if (actualDataRowCount !== expectedSheet.dataRowCount) {
      return fail(
        `Expected ${expectedSheet.sheetName} to contain ${expectedSheet.dataRowCount} data rows, but calculated ${actualDataRowCount} from get_sheet_profile.`,
        details,
      );
    }
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
  for (const expectedSheet of expectedSheetRows) {
    if (!containsSheetDataRowCount(answer, expectedSheet, expectedSheetRows)) {
      return fail(
        `The tool results were correct, but the final assistant answer did not report ${expectedSheet.sheetName} as having ${expectedSheet.dataRowCount} data rows.`,
        details,
      );
    }
  }

  return {
    evaluator: 'excel_workbook_correctness',
    score: 1,
    passed: true,
    details,
  };
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

/** Collects all successful sheet-profile tool results without reading display text or arguments. */
function findSuccessfulSheetProfiles(result: ExecuteTurnResult): readonly ToolResultMessage[] {
  return result.messages.filter(
    (message): message is ToolResultMessage =>
      message.role === 'tool' && message.name === 'get_sheet_profile' && message.isError !== true,
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

/** Reads the structured worksheet name and total row count from a profile result. */
function readSheetProfileDetails(
  details: unknown,
): { readonly sheetName: string; readonly rowCount: number } | undefined {
  if (
    !isRecord(details) ||
    typeof details.sheetName !== 'string' ||
    details.sheetName.trim().length === 0 ||
    !isValidSheetCount(details.rowCount)
  ) {
    return undefined;
  }
  return { sheetName: details.sheetName, rowCount: details.rowCount };
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

/** Reads and validates the worksheet-row Golden contract used by Case 2. */
function readExpectedSheetRows(
  value: unknown,
): readonly ExcelGoldenSheetRowsExpected[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.sheetRows) || value.sheetRows.length === 0) {
    return undefined;
  }
  const rows: ExcelGoldenSheetRowsExpected[] = [];
  for (const candidate of value.sheetRows) {
    if (
      !isRecord(candidate) ||
      typeof candidate.sheetName !== 'string' ||
      candidate.sheetName.trim().length === 0 ||
      !isValidSheetCount(candidate.dataRowCount) ||
      !isValidSheetCount(candidate.headerRowCount)
    ) {
      return undefined;
    }
    rows.push({
      sheetName: candidate.sheetName,
      dataRowCount: candidate.dataRowCount,
      headerRowCount: candidate.headerRowCount,
    });
  }
  return rows;
}

/** Distinguishes Case 2's worksheet-row expected contract from Case 1. */
function hasExpectedSheetRows(value: unknown): boolean {
  return isRecord(value) && value.sheetRows !== undefined;
}

/** Checks that a sheet name's answer segment contains its expected data-row integer. */
function containsSheetDataRowCount(
  answer: string,
  expected: ExcelGoldenSheetRowsExpected,
  allExpected: readonly ExcelGoldenSheetRowsExpected[],
): boolean {
  let searchFrom = 0;
  while (true) {
    const start = answer.indexOf(expected.sheetName, searchFrom);
    if (start < 0) return false;
    const nextSheetStart = allExpected
      .filter((sheet) => sheet.sheetName !== expected.sheetName)
      .map((sheet) => answer.indexOf(sheet.sheetName, start + expected.sheetName.length))
      .filter((index) => index >= 0)
      .sort((left, right) => left - right)[0];
    const segment = answer.slice(start, nextSheetStart ?? answer.length);
    if (containsInteger(segment, expected.dataRowCount)) return true;
    searchFrom = start + expected.sheetName.length;
  }
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
