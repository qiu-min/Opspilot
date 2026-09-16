import type { ExecuteTurnResult, ToolCompletedEvent } from '@opspilot/application';

import type { EvalRunResult } from '../core/eval-run-result.js';
import type { EvalScore } from '../core/eval-score.js';
import type { Evaluator } from '../core/evaluator.js';
import type {
  ExcelGoldenSheetRowsExpected,
  ExcelGoldenTopRegionSalesExpected,
} from '../datasets/excel-dataset-loader.js';
import {
  extractAssistantText,
  loadDurableExcelEvidence,
  type DurableExcelEvidence,
  type DurableSessionReader,
  type DurableTurnReader,
} from './durable-turn-evidence.js';

const REGIONAL_SALES_COLUMNS = {
  group: 'Region',
  sales: 'Revenue',
  orderId: 'OrderID',
} as const;
const SALES_COMPARISON_TOLERANCE = 0.01;
const EVALUATOR_NAME = 'excel_workbook_correctness';

/** Dependencies used to read the durable state required by Excel correctness evaluation. */
export interface ExcelWorkbookCorrectnessEvaluatorOptions {
  readonly turns: DurableTurnReader;
  readonly sessions: DurableSessionReader;
}

/** Deterministically evaluates Excel outcome facts from durable Turn and Session evidence. */
export class ExcelWorkbookCorrectnessEvaluator implements Evaluator<unknown, ExecuteTurnResult> {
  public readonly name = EVALUATOR_NAME;

  private readonly turns: DurableTurnReader;
  private readonly sessions: DurableSessionReader;

  /** Creates an evaluator that never needs the transient ExecuteTurn result as evidence. */
  public constructor(options: ExcelWorkbookCorrectnessEvaluatorOptions) {
    this.turns = options.turns;
    this.sessions = options.sessions;
  }

  /** Returns a binary score for the supported deterministic Excel Golden contracts. */
  public async evaluate(input: {
    readonly expected: unknown;
    readonly actual: ExecuteTurnResult | undefined;
    readonly run: EvalRunResult<ExecuteTurnResult>;
  }): Promise<EvalScore> {
    if (hasExpectedWorkbookMutation(input.expected)) {
      return pass({
        evidenceSource: 'durable',
        kind: 'skipped',
        reason: 'Workbook mutation expectations are evaluated by workbook_mutation.',
      });
    }

    const turnId = readTurnId(input.run.metadata);
    if (turnId === undefined) {
      return fail(
        'Eval run did not expose a valid turnId for durable Excel evaluation.',
        durableDetails(null),
      );
    }

    const expectedTopRegionSales = hasExpectedTopRegionSales(input.expected)
      ? readExpectedTopRegionSales(input.expected)
      : undefined;
    const expectedSheetRows = hasExpectedSheetRows(input.expected)
      ? readExpectedSheetRows(input.expected)
      : undefined;
    const expectedSheetCount = readExpectedSheetCount(input.expected);

    if (hasExpectedTopRegionSales(input.expected) && expectedTopRegionSales === undefined) {
      return fail(
        'expected.topRegionSales is invalid.',
        { ...durableDetails(turnId), ...topRegionDetails(null) },
      );
    }
    if (hasExpectedSheetRows(input.expected) && expectedSheetRows === undefined) {
      return fail(
        'expected.sheetRows must be a non-empty array of valid worksheet row expectations.',
        { ...durableDetails(turnId), sheets: [] },
      );
    }
    if (!hasExpectedTopRegionSales(input.expected) && !hasExpectedSheetRows(input.expected)) {
      const details: Record<string, unknown> = {
        ...durableDetails(turnId),
        expectedSheetCount,
        actualToolSheetCount: null,
      };
      if (!isValidSheetCount(expectedSheetCount)) {
        return fail('expected.sheetCount must be an integer >= 0.', details);
      }
    }

    let evidence: DurableExcelEvidence;
    try {
      evidence = loadDurableExcelEvidence(turnId, {
        turns: this.turns,
        sessions: this.sessions,
      });
    } catch (error: unknown) {
      return fail(errorMessage(error), durableDetails(turnId));
    }

    if (expectedTopRegionSales !== undefined) {
      return evaluateTopRegionSales(evidence, expectedTopRegionSales);
    }
    if (expectedSheetRows !== undefined) {
      return evaluateSheetRows(evidence, expectedSheetRows);
    }

    return evaluateSheetCount(evidence, expectedSheetCount!);
  }
}

/** Evaluates Case 1 using the last successful durable workbook-info event. */
function evaluateSheetCount(
  evidence: DurableExcelEvidence,
  expectedSheetCount: number,
): EvalScore {
  const details: Record<string, unknown> = {
    ...durableDetails(evidence),
    expectedSheetCount,
    actualToolSheetCount: null,
  };
  const attempts = evidence.toolEvents.filter((event) => event.name === 'get_workbook_info');
  if (attempts.length === 0) {
    return fail('get_workbook_info was not executed.', details);
  }

  const successfulAttempts = attempts.filter((event) => !event.isError);
  if (successfulAttempts.length === 0) {
    return fail('get_workbook_info tool execution failed.', details);
  }

  const toolEvent = successfulAttempts.at(-1)!;
  addToolDiagnostics(details, toolEvent);
  if (toolEvent.resultDetails === undefined) {
    return fail('get_workbook_info completed without durable resultDetails.', details);
  }

  const actualToolSheetCount = readSheetCount(toolEvent.resultDetails);
  details.actualToolSheetCount = actualToolSheetCount ?? null;
  if (actualToolSheetCount === undefined) {
    return fail('get_workbook_info returned invalid sheetCount details.', details);
  }
  if (actualToolSheetCount !== expectedSheetCount) {
    return fail(
      `Expected sheetCount ${expectedSheetCount} but tool returned ${actualToolSheetCount}.`,
      details,
    );
  }

  const answer = extractAssistantText(evidence.finalAssistant);
  if (!containsInteger(answer, expectedSheetCount)) {
    return fail(
      `The workbook tool returned the correct sheet count, but the final assistant answer did not contain the expected value ${expectedSheetCount}.`,
      details,
    );
  }

  return pass(details);
}

/** Evaluates Case 3 using the most recent complete valid durable aggregate candidate. */
function evaluateTopRegionSales(
  evidence: DurableExcelEvidence,
  expected: ExcelGoldenTopRegionSalesExpected,
): EvalScore {
  const details: Record<string, unknown> = {
    ...durableDetails(evidence),
    ...topRegionDetails(expected),
  };
  const aggregateAttempts = evidence.toolEvents.filter((event) => event.name === 'aggregate_data');
  if (aggregateAttempts.length === 0) {
    return fail('aggregate_data was not executed.', details);
  }

  const successfulAttempts = aggregateAttempts.filter((event) => !event.isError);
  if (successfulAttempts.length === 0) {
    return fail('aggregate_data tool execution failed.', details);
  }

  const aggregateCandidates = successfulAttempts
    .map((event) => {
      const aggregate = readRegionalSalesAggregate(event.resultDetails, expected.sheetName);
      return aggregate === undefined
        ? undefined
        : { ...aggregate, callId: event.callId, eventSequence: event.sequence };
    })
    .filter((candidate): candidate is RegionalSalesAggregate => candidate !== undefined);
  const aggregate =
    [...aggregateCandidates]
      .reverse()
      .find(
        (candidate) =>
          !candidate.truncated &&
          candidate.rows.length >= candidate.resultRowCount &&
          candidate.returnedRowCount >= candidate.resultRowCount,
      ) ?? aggregateCandidates.at(-1);

  if (aggregate === undefined) {
    if (successfulAttempts.every((event) => event.resultDetails === undefined)) {
      return fail('aggregate_data completed without durable resultDetails.', details);
    }
    return fail(
      `No aggregate_data result for ${expected.sheetName} contained the required regional sales aggregation.`,
      details,
    );
  }

  details.aggregateCallId = aggregate.callId;
  details.aggregateEventSequence = aggregate.eventSequence;
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

  const answer = extractAssistantText(evidence.finalAssistant);
  if (!containsTopRegionSalesAnswer(answer, expected)) {
    return fail(
      'The aggregate result was correct, but the final assistant answer did not report the expected top region and metrics together.',
      details,
    );
  }

  return pass(details);
}

/** Describes one parsed aggregate result and its durable event identity. */
interface RegionalSalesAggregate {
  readonly columns: readonly AggregateColumnMetadata[];
  readonly rows: readonly (readonly unknown[])[];
  readonly groupIndex: number;
  readonly salesIndex: number;
  readonly orderCountIndex: number;
  readonly resultRowCount: number;
  readonly returnedRowCount: number;
  readonly truncated: boolean;
  readonly callId: string;
  readonly eventSequence: number;
}

/** Describes one structured aggregate column without trusting its display alias. */
interface AggregateColumnMetadata {
  readonly kind: 'group' | 'metric';
  readonly sourceColumn: string;
  readonly operation?: string;
}

/** Reads aggregate metadata without trusting aliases or display text. */
function readRegionalSalesAggregate(
  details: unknown,
  expectedSheetName: string,
): Omit<RegionalSalesAggregate, 'callId' | 'eventSequence'> | undefined {
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

/** Distinguishes Case 3's expected contract from the discovery contracts. */
function hasExpectedTopRegionSales(value: unknown): boolean {
  return isRecord(value) && value.topRegionSales !== undefined;
}

/** Keeps mutation-only cases out of this evaluator's read-only Golden contracts. */
function hasExpectedWorkbookMutation(value: unknown): boolean {
  return isRecord(value) && value.workbookMutation !== undefined;
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

/** Evaluates Case 2 using the last valid durable profile for each expected worksheet. */
function evaluateSheetRows(
  evidence: DurableExcelEvidence,
  expectedSheetRows: readonly ExcelGoldenSheetRowsExpected[],
): EvalScore {
  const details: Record<string, unknown> = {
    ...durableDetails(evidence),
    sheets: expectedSheetRows.map((sheet) => ({
      sheetName: sheet.sheetName,
      expectedDataRowCount: sheet.dataRowCount,
      expectedHeaderRowCount: sheet.headerRowCount,
      actualToolRowCount: null,
      actualDataRowCount: null,
    })),
  };
  const successfulProfiles = evidence.toolEvents.filter(
    (event) => event.name === 'get_sheet_profile' && !event.isError,
  );
  const detailSheets = details.sheets as Array<Record<string, unknown>>;

  for (let index = 0; index < expectedSheetRows.length; index += 1) {
    const expectedSheet = expectedSheetRows[index]!;
    const profile = [...successfulProfiles]
      .reverse()
      .map((event) => ({ event, profile: readSheetProfileDetails(event.resultDetails) }))
      .find((candidate) => candidate.profile?.sheetName === expectedSheet.sheetName);

    if (profile === undefined) {
      const matchingRawAttempt = successfulProfiles.find(
        (event) => readDeclaredSheetName(event.resultDetails) === expectedSheet.sheetName,
      );
      if (matchingRawAttempt !== undefined && matchingRawAttempt.resultDetails === undefined) {
        return fail('get_sheet_profile completed without durable resultDetails.', details);
      }
      if (matchingRawAttempt !== undefined) {
        return fail(
          `get_sheet_profile returned invalid details for ${expectedSheet.sheetName}.`,
          details,
        );
      }
      if (successfulProfiles.some((event) => event.resultDetails === undefined)) {
        return fail('get_sheet_profile completed without durable resultDetails.', details);
      }
      return fail(
        `No successful get_sheet_profile result was found for ${expectedSheet.sheetName}.`,
        details,
      );
    }

    addToolDiagnostics(detailSheets[index]!, profile.event);
    const actualProfile = profile.profile!;
    const actualDataRowCount = actualProfile.rowCount - expectedSheet.headerRowCount;
    detailSheets[index] = {
      ...detailSheets[index],
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

  const answer = extractAssistantText(evidence.finalAssistant);
  for (const expectedSheet of expectedSheetRows) {
    if (!containsSheetDataRowCount(answer, expectedSheet, expectedSheetRows)) {
      return fail(
        `The tool results were correct, but the final assistant answer did not report ${expectedSheet.sheetName} as having ${expectedSheet.dataRowCount} data rows.`,
        details,
      );
    }
  }

  return pass(details);
}

/** Reads one successful worksheet profile's durable structured details. */
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

/** Reads a worksheet name for diagnostics without accepting the whole profile as valid. */
function readDeclaredSheetName(details: unknown): string | undefined {
  return isRecord(details) && typeof details.sheetName === 'string'
    ? details.sheetName
    : undefined;
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

/** Reads a workbook-info sheet count from a structured durable result. */
function readSheetCount(details: unknown): number | undefined {
  if (!isRecord(details) || !isValidSheetCount(details.sheetCount)) return undefined;
  return details.sheetCount;
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
    const before = index === 0 ? '' : text[index - 1]!;
    const after = text[index + token.length] ?? '';
    if (!isAsciiDigit(before) && !isAsciiDigit(after)) return true;
    searchFrom = index + token.length;
  }
}

/** Checks an ASCII digit boundary for deterministic answer matching. */
function isAsciiDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}

/** Reads only a non-blank turn ID from the executor metadata boundary. */
function readTurnId(metadata: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const turnId = metadata?.turnId;
  return typeof turnId === 'string' && turnId.trim().length > 0 ? turnId : undefined;
}

/** Builds common durable-evidence diagnostics before and after evidence loading. */
function durableDetails(
  value: string | DurableExcelEvidence | null,
): Record<string, unknown> {
  if (value === null) {
    return { evidenceSource: 'durable', turnId: null, finalAssistantEntryId: null };
  }
  if (typeof value === 'string') {
    return { evidenceSource: 'durable', turnId: value, finalAssistantEntryId: null };
  }
  return {
    evidenceSource: 'durable',
    turnId: value.turnId,
    sessionId: value.sessionId,
    finalAssistantEntryId: value.finalAssistantEntryId,
  };
}

/** Builds the initial Case 3 diagnostics without copying durable result rows into the report. */
function topRegionDetails(
  expected: ExcelGoldenTopRegionSalesExpected | null,
): Record<string, unknown> {
  return {
    sheetName: expected?.sheetName ?? null,
    expectedRegion: expected?.region ?? null,
    actualRegion: null,
    expectedTotalSales: expected?.totalSales ?? null,
    actualTotalSales: null,
    expectedOrderCount: expected?.orderCount ?? null,
    actualOrderCount: null,
    highestSalesVerified: false,
  };
}

/** Adds only the identity of a selected durable tool event to evaluator diagnostics. */
function addToolDiagnostics(
  details: Record<string, unknown>,
  event: ToolCompletedEvent,
): void {
  details.toolCallId = event.callId;
  details.toolEventSequence = event.sequence;
}

/** Creates a passing score while retaining only durable evidence identities and derived facts. */
function pass(details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: EVALUATOR_NAME, score: 1, passed: true, details };
}

/** Creates the normalized binary failure score used by this evaluator. */
function fail(reason: string, details: Readonly<Record<string, unknown>>): EvalScore {
  return { evaluator: EVALUATOR_NAME, score: 0, passed: false, reason, details };
}

/** Converts an unknown thrown value into a stable evaluator failure message. */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

/** Checks an unknown details payload without weakening the evaluator contract. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
