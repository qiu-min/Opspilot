import type {
  ExecuteTurnResult,
  JsonValue,
  SessionFinishReason,
  TurnEvent,
} from '@opspilot/application';
import { Session, Turn } from '@opspilot/application';
import type { AssistantMessage, ToolResultMessage } from '@opspilot/model-gateway';
import { describe, expect, it } from 'vitest';

import type { EvalRunResult } from '../src/core/eval-run-result.js';
import {
  ExcelWorkbookCorrectnessEvaluator,
  type DurableSessionReader,
  type DurableTurnReader,
} from '../src/index.js';

const expectedSheetCount = { sheetCount: 3 };
const expectedSheetRows = {
  sheetRows: [
    { sheetName: 'SalesData', dataRowCount: 120, headerRowCount: 1 },
    { sheetName: 'Products', dataRowCount: 8, headerRowCount: 1 },
    { sheetName: 'MonthlySummary', dataRowCount: 7, headerRowCount: 1 },
  ],
};
const expectedTopRegionSales = {
  topRegionSales: {
    sheetName: 'SalesData',
    region: 'South',
    totalSales: 92726.94,
    orderCount: 40,
  },
};

describe('ExcelWorkbookCorrectnessEvaluator', () => {
  it('skips mutation-only expected contracts for the dedicated mutation evaluator', async () => {
    const fixture = createFixture({ assistantText: 'Verified' });

    const result = await evaluate(
      {
        workbookMutation: {
          sheetName: 'MonthlySummary',
          range: 'H2',
          expectedValues: [['Verified']],
        },
      },
      fixture,
    );

    expect(result).toMatchObject({
      evaluator: 'excel_workbook_correctness',
      score: 1,
      passed: true,
      details: { kind: 'skipped' },
    });
  });

  it('passes from durable evidence even when the runtime result is undefined', async () => {
    const fixture = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '这个工作簿共有 3 个工作表。',
    });

    const result = await evaluate(expectedSheetCount, fixture, undefined);

    expect(result).toMatchObject({
      evaluator: 'excel_workbook_correctness',
      score: 1,
      passed: true,
      details: {
        evidenceSource: 'durable',
        turnId: 'turn-1',
        finalAssistantEntryId: fixture.finalAssistantEntryId,
        expectedSheetCount: 3,
        actualToolSheetCount: 3,
        toolCallId: 'get_workbook_info-call-0',
      },
    });
  });

  it('ignores a poisoned runtime tool and assistant result', async () => {
    const fixture = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '这个工作簿共有 3 个工作表。',
    });

    const result = await evaluate(
      expectedSheetCount,
      fixture,
      runtimeResult(workbookInfoMessage(999), assistantMessage('999')),
    );

    expect(result.passed).toBe(true);
  });

  it('fails when durable evidence is wrong even if the runtime result says the expected value', async () => {
    const fixture = createFixture({
      tools: [workbookInfoTool(999)],
      assistantText: '999',
    });

    const result = await evaluate(
      expectedSheetCount,
      fixture,
      runtimeResult(workbookInfoMessage(3), assistantMessage('3')),
    );

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'Expected sheetCount 3 but tool returned 999.',
    });
  });

  it.each([undefined, null, '', '   '])('fails when durable turnId metadata is %p', async (turnId) => {
    const fixture = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '3',
    });

    const result = await new ExcelWorkbookCorrectnessEvaluator(fixture).evaluate({
      expected: expectedSheetCount,
      actual: undefined,
      run: { caseId: 'case-1', status: 'completed', durationMs: 1, metadata: { turnId } },
    });

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason: 'Eval run did not expose a valid turnId for durable Excel evaluation.',
    });
  });

  it('fails when get_workbook_info is missing, failed, or lacks durable details', async () => {
    const missing = await evaluate(expectedSheetCount, createFixture({ assistantText: '3' }));
    const failed = await evaluate(
      expectedSheetCount,
      createFixture({ tools: [workbookInfoTool(3, true)], assistantText: '3' }),
    );
    const withoutDetails = await evaluate(
      expectedSheetCount,
      createFixture({ tools: [workbookInfoTool(undefined)], assistantText: '3' }),
    );

    expect(missing.reason).toBe('get_workbook_info was not executed.');
    expect(failed.reason).toBe('get_workbook_info tool execution failed.');
    expect(withoutDetails.reason).toBe('get_workbook_info completed without durable resultDetails.');
  });

  it('fails when the workbook tool is correct but the durable final answer is wrong', async () => {
    const result = await evaluate(
      expectedSheetCount,
      createFixture({ tools: [workbookInfoTool(3)], assistantText: '这个工作簿共有 2 个工作表。' }),
    );

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'The workbook tool returned the correct sheet count, but the final assistant answer did not contain the expected value 3.',
    });
  });

  it('resolves the final answer from turn_completed.resultLeafId, not the Session active leaf', async () => {
    const fixture = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '这个工作簿共有 3 个工作表。',
      appendLaterAssistantText: 'A later Session Turn reports 999.',
    });

    const result = await evaluate(expectedSheetCount, fixture);

    expect(result.passed).toBe(true);
  });

  it('passes Case 2 from the last valid durable profile for each sheet', async () => {
    const result = await evaluate(
      expectedSheetRows,
      createFixture({
        tools: [
          sheetProfileTool('SalesData', 121),
          sheetProfileTool('Products', 9),
          sheetProfileTool('MonthlySummary', 8),
        ],
        assistantText:
          'SalesData 有 120 行数据；Products 有 8 行数据；MonthlySummary 有 7 行数据。',
      }),
    );

    expect(result).toMatchObject({ evaluator: 'excel_workbook_correctness', score: 1, passed: true });
    expect(result.details).toMatchObject({
      evidenceSource: 'durable',
      sheets: [
        { sheetName: 'SalesData', actualToolRowCount: 121, actualDataRowCount: 120 },
        { sheetName: 'Products', actualToolRowCount: 9, actualDataRowCount: 8 },
        { sheetName: 'MonthlySummary', actualToolRowCount: 8, actualDataRowCount: 7 },
      ],
    });
  });

  it('supports a later valid profile after an earlier error', async () => {
    const result = await evaluate(
      expectedSheetRows,
      createFixture({
        tools: [
          sheetProfileTool('SalesData', 121, true),
          sheetProfileTool('SalesData', 121),
          sheetProfileTool('Products', 9),
          sheetProfileTool('MonthlySummary', 8),
        ],
        assistantText: 'SalesData 120 行；Products 8 行；MonthlySummary 7 行。',
      }),
    );

    expect(result.passed).toBe(true);
  });

  it('fails Case 2 for wrong, missing, failed, invalid, and detail-less profiles', async () => {
    const wrong = await evaluate(
      expectedSheetRows,
      createFixture({
        tools: [sheetProfileTool('SalesData', 120), sheetProfileTool('Products', 9), sheetProfileTool('MonthlySummary', 8)],
        assistantText: 'SalesData 119 行；Products 8 行；MonthlySummary 7 行。',
      }),
    );
    const missing = await evaluate(
      expectedSheetRows,
      createFixture({
        tools: [sheetProfileTool('SalesData', 121), sheetProfileTool('MonthlySummary', 8)],
        assistantText: 'SalesData 120 行；Products 8 行；MonthlySummary 7 行。',
      }),
    );
    const failed = await evaluate(
      expectedSheetRows,
      createFixture({
        tools: [sheetProfileTool('SalesData', 121), sheetProfileTool('Products', 9), sheetProfileTool('MonthlySummary', 8, true)],
        assistantText: 'SalesData 120 行；Products 8 行；MonthlySummary 7 行。',
      }),
    );
    const invalid = await evaluate(
      expectedSheetRows,
      createFixture({
        tools: [profileWithDetails({ sheetName: 'SalesData', rowCount: '121' }), sheetProfileTool('Products', 9), sheetProfileTool('MonthlySummary', 8)],
        assistantText: 'SalesData 120 行；Products 8 行；MonthlySummary 7 行。',
      }),
    );
    const withoutDetails = await evaluate(
      expectedSheetRows,
      createFixture({
        tools: [sheetProfileTool(undefined, 0), sheetProfileTool('Products', 9), sheetProfileTool('MonthlySummary', 8)],
        assistantText: 'SalesData 120 行；Products 8 行；MonthlySummary 7 行。',
      }),
    );

    expect(wrong.reason).toContain('SalesData');
    expect(missing.reason).toBe('No successful get_sheet_profile result was found for Products.');
    expect(failed.reason).toBe('No successful get_sheet_profile result was found for MonthlySummary.');
    expect(invalid.reason).toBe('get_sheet_profile returned invalid details for SalesData.');
    expect(withoutDetails.reason).toBe('get_sheet_profile completed without durable resultDetails.');
  });

  it('passes Case 3 using durable structured column metadata and final text', async () => {
    const result = await evaluate(
      expectedTopRegionSales,
      createFixture({
        tools: [aggregateDataTool()],
        assistantText: '销售额最高的是 South，销售额合计为 92,726.94，共 40 笔订单。',
      }),
    );

    expect(result).toMatchObject({
      evaluator: 'excel_workbook_correctness',
      score: 1,
      passed: true,
      details: expect.objectContaining({
        evidenceSource: 'durable',
        sheetName: 'SalesData',
        expectedRegion: 'South',
        actualRegion: 'South',
        expectedTotalSales: 92726.94,
        actualTotalSales: 92726.94,
        expectedOrderCount: 40,
        actualOrderCount: 40,
        highestSalesVerified: true,
        aggregateCallId: 'aggregate-call-0',
      }),
    });
  });

  it('supports a later complete aggregate after an earlier failed attempt', async () => {
    const result = await evaluate(
      expectedTopRegionSales,
      createFixture({
        tools: [aggregateDataTool([], true), aggregateDataTool()],
        assistantText: 'South / 92,726.94 / 40',
      }),
    );

    expect(result.passed).toBe(true);
  });

  it('prefers the latest complete aggregate candidate over a later incomplete candidate', async () => {
    const result = await evaluate(
      expectedTopRegionSales,
      createFixture({
        tools: [
          aggregateDataTool(completeRegionalRows()),
          aggregateDataTool(completeRegionalRows().slice(0, 2), false, {
            resultRowCount: 4,
            returnedRowCount: 2,
            truncated: true,
          }),
        ],
        assistantText: 'South / 92,726.94 / 40',
      }),
    );

    expect(result.passed).toBe(true);
    expect(result.details).toMatchObject({ aggregateEventSequence: 0 });
  });

  it('uses the latest parseable incomplete candidate when no complete aggregate exists', async () => {
    const result = await evaluate(
      expectedTopRegionSales,
      createFixture({
        tools: [
          aggregateDataTool(completeRegionalRows().slice(0, 2), false, {
            resultRowCount: 4,
            returnedRowCount: 2,
            truncated: true,
          }),
          aggregateDataTool(completeRegionalRows().slice(0, 2), false, {
            resultRowCount: 4,
            returnedRowCount: 2,
            truncated: true,
          }),
        ],
        assistantText: 'South / 92,726.94 / 40',
      }),
    );

    expect(result).toMatchObject({
      score: 0,
      passed: false,
      reason:
        'aggregate_data result was truncated, so the highest-sales region cannot be verified deterministically.',
      details: { aggregateEventSequence: 1 },
    });
  });

  it('fails Case 3 when the aggregate is missing, failed, detail-less, or invalid', async () => {
    const missing = await evaluate(
      expectedTopRegionSales,
      createFixture({ assistantText: 'South / 92,726.94 / 40' }),
    );
    const failed = await evaluate(
      expectedTopRegionSales,
      createFixture({ tools: [aggregateDataTool([], true)], assistantText: 'cannot calculate' }),
    );
    const withoutDetails = await evaluate(
      expectedTopRegionSales,
      createFixture({ tools: [aggregateWithoutDetails()], assistantText: 'cannot calculate' }),
    );
    const invalid = await evaluate(
      expectedTopRegionSales,
      createFixture({
        tools: [aggregateWithDetails({ sheetName: 'SalesData', rows: [] })],
        assistantText: 'cannot calculate',
      }),
    );

    expect(missing.reason).toBe('aggregate_data was not executed.');
    expect(failed.reason).toBe('aggregate_data tool execution failed.');
    expect(withoutDetails.reason).toBe('aggregate_data completed without durable resultDetails.');
    expect(invalid.reason).toContain('No aggregate_data result for SalesData');
  });

  it('fails Case 3 for wrong metrics, non-maximum South, truncation, and wrong final text', async () => {
    const wrongSalesRows = completeRegionalRows();
    wrongSalesRows[1] = ['South', 92000, 40];
    const wrongSales = await evaluate(
      expectedTopRegionSales,
      createFixture({ tools: [aggregateDataTool(wrongSalesRows)], assistantText: 'South / 92,000 / 40' }),
    );
    const wrongOrdersRows = completeRegionalRows();
    wrongOrdersRows[1] = ['South', 92726.94, 39];
    const wrongOrders = await evaluate(
      expectedTopRegionSales,
      createFixture({ tools: [aggregateDataTool(wrongOrdersRows)], assistantText: 'South / 92,726.94 / 39' }),
    );
    const nonMaximumRows = completeRegionalRows();
    nonMaximumRows[3] = ['West', 100000, 34];
    const nonMaximum = await evaluate(
      expectedTopRegionSales,
      createFixture({ tools: [aggregateDataTool(nonMaximumRows)], assistantText: 'South / 92,726.94 / 40' }),
    );
    const wrongText = await evaluate(
      expectedTopRegionSales,
      createFixture({ tools: [aggregateDataTool()], assistantText: 'North / 92,726.94 / 40' }),
    );

    expect(wrongSales.reason).toContain('total sales 92726.94');
    expect(wrongOrders.reason).toContain('order count 40');
    expect(nonMaximum.reason).toBe(
      'South had the expected sales total, but another region had a higher total.',
    );
    expect(wrongText.reason).toBe(
      'The aggregate result was correct, but the final assistant answer did not report the expected top region and metrics together.',
    );
  });

  it.each(['92726.94', '92,726.94'])('accepts supported amount format %s', async (amount) => {
    const result = await evaluate(
      expectedTopRegionSales,
      createFixture({
        tools: [aggregateDataTool()],
        assistantText: `SalesData: South has the highest sales, total sales ${amount}, 40 orders.`,
      }),
    );

    expect(result.passed).toBe(true);
  });

  it('requires a successful durable Turn and a referenced successful final assistant', async () => {
    const running = createFixture({ tools: [workbookInfoTool(3)], assistantText: '3', turnStatus: 'running' });
    const nullLeaf = createFixture({ tools: [workbookInfoTool(3)], assistantText: '3', resultLeafId: null });
    const missingEntry = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '3',
      resultLeafId: 'missing-entry',
    });
    const toolLeaf = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '3',
      resultLeafId: 'tool-entry',
    });
    const userLeaf = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '3',
      resultLeafId: 'input-entry',
    });
    const missingAssistantEvent = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '3',
      includeAssistantEvent: false,
    });
    const mismatchedAssistantEvent = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '3',
      assistantEventEntryId: 'other-entry',
    });
    const failedAssistant = createFixture({
      tools: [workbookInfoTool(3)],
      assistantText: '3',
      assistantFinishReason: 'error',
    });

    expect((await evaluate(expectedSheetCount, running)).reason).toBe(
      'Durable Turn did not complete successfully.',
    );
    expect((await evaluate(expectedSheetCount, nullLeaf)).reason).toBe(
      'Completed Turn does not reference a durable result leaf.',
    );
    expect((await evaluate(expectedSheetCount, missingEntry)).passed).toBe(false);
    expect((await evaluate(expectedSheetCount, toolLeaf)).passed).toBe(false);
    expect((await evaluate(expectedSheetCount, userLeaf)).passed).toBe(false);
    expect((await evaluate(expectedSheetCount, missingAssistantEvent)).passed).toBe(false);
    expect((await evaluate(expectedSheetCount, mismatchedAssistantEvent)).passed).toBe(false);
    expect((await evaluate(expectedSheetCount, failedAssistant)).reason).toBe(
      'The durable Turn result does not reference a successful final assistant answer.',
    );
  });
});

interface DurableFixture {
  readonly turns: DurableTurnReader;
  readonly sessions: DurableSessionReader;
  readonly finalAssistantEntryId: string;
}

interface FixtureOptions {
  readonly tools?: readonly DurableToolSpec[];
  readonly assistantText: string;
  readonly assistantFinishReason?: SessionFinishReason;
  readonly includeAssistantEvent?: boolean;
  readonly assistantEventEntryId?: string;
  readonly resultLeafId?: string | null;
  readonly appendLaterAssistantText?: string;
  readonly turnStatus?: 'completed' | 'running' | 'failed' | 'cancelled';
}

interface DurableToolSpec {
  readonly name: string;
  readonly details?: JsonValue;
  readonly isError?: boolean;
}

/** Creates a valid Domain-backed durable Turn/Session fixture without runtime evidence. */
function createFixture(options: FixtureOptions): DurableFixture {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const session = Session.create({ id: 'session-1', timestamp });
  const inputEntry = session.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'workbook prompt' }],
  });
  const events: TurnEvent[] = [];
  const tools = options.tools ?? [];
  const toolEntryByName = new Map<string, string>();

  for (const [index, tool] of tools.entries()) {
    const callId = tool.name === 'aggregate_data' ? `aggregate-call-${index}` : `${tool.name}-call-${index}`;
    const entry = session.appendMessage({
      role: 'tool',
      callId,
      name: tool.name,
      content: [{ type: 'text', text: 'durable display text' }],
      isError: tool.isError ?? false,
    });
    toolEntryByName.set(tool.name, entry.id);
    events.push({
      version: 2,
      id: `tool-event-${index}`,
      turnId: 'turn-1',
      sessionId: 'session-1',
      sequence: events.length,
      attempt: 1,
      timestamp,
      type: 'tool_completed',
      callId,
      name: tool.name,
      isError: tool.isError ?? false,
      resultEntryId: entry.id,
      sessionLeafId: entry.id,
      ...(tool.details === undefined ? {} : { resultDetails: tool.details }),
    });
  }

  const assistantEntry = session.appendMessage({
    role: 'assistant',
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    content: [{ type: 'text', text: options.assistantText }],
    finishReason: options.assistantFinishReason ?? 'stop',
  });
  if (options.appendLaterAssistantText !== undefined) {
    session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [{ type: 'text', text: options.appendLaterAssistantText }],
      finishReason: 'stop',
    });
  }
  if (options.includeAssistantEvent !== false) {
    events.push({
      version: 2,
      id: 'assistant-event',
      turnId: 'turn-1',
      sessionId: 'session-1',
      sequence: events.length,
      attempt: 1,
      timestamp,
      type: 'assistant_message_completed',
      entryId: options.assistantEventEntryId ?? assistantEntry.id,
      sessionLeafId: options.assistantEventEntryId ?? assistantEntry.id,
    });
  }

  const resultLeafId =
    options.resultLeafId === 'tool-entry'
      ? toolEntryByName.get('get_workbook_info') ?? 'missing-tool-entry'
      : options.resultLeafId === 'input-entry'
        ? inputEntry.id
        : options.resultLeafId === undefined
          ? assistantEntry.id
          : options.resultLeafId;
  events.push({
    version: 2,
    id: 'turn-completed-event',
    turnId: 'turn-1',
    sessionId: 'session-1',
    sequence: events.length,
    attempt: 1,
    timestamp,
    type: 'turn_completed',
    resultLeafId,
  });

  const turn = createTurn(timestamp, resultLeafId, options.turnStatus ?? 'completed');
  return createReader(turn, events, session, assistantEntry.id);
}

/** Creates the Domain Turn state needed by a durable evaluator fixture. */
function createTurn(
  timestamp: string,
  resultLeafId: string | null,
  status: FixtureOptions['turnStatus'],
): Turn {
  const durableTurn = Turn.create({
    id: 'turn-1',
    sessionId: 'session-1',
    createdAt: timestamp,
  });
  durableTurn.start(timestamp);
  if (status === 'completed') durableTurn.complete(resultLeafId, timestamp);
  if (status === 'failed') durableTurn.fail(timestamp);
  if (status === 'cancelled') durableTurn.cancel(timestamp);
  return durableTurn;
}

/** Creates reader methods over one immutable fixture snapshot. */
function createReader(
  turn: Turn,
  events: readonly TurnEvent[],
  session: Session,
  finalAssistantEntryId: string,
): DurableFixture {
  return {
    turns: {
      load: (turnId: string) => {
        if (turnId !== 'turn-1') throw new Error(`Unknown Turn ${turnId}.`);
        return turn;
      },
      loadEvents: (turnId: string) => {
        if (turnId !== 'turn-1') throw new Error(`Unknown Turn ${turnId}.`);
        return events;
      },
    },
    sessions: {
      load: (sessionId: string) => {
        if (sessionId !== 'session-1') throw new Error(`Unknown Session ${sessionId}.`);
        return session;
      },
    },
    finalAssistantEntryId,
  };
}

/** Evaluates one fixture using only its durable reader methods. */
async function evaluate(
  expected: unknown,
  fixture: DurableFixture,
  actual?: ExecuteTurnResult,
): Promise<Awaited<ReturnType<ExcelWorkbookCorrectnessEvaluator['evaluate']>>> {
  return await new ExcelWorkbookCorrectnessEvaluator({ turns: fixture.turns, sessions: fixture.sessions }).evaluate({
    expected,
    actual,
    run: completedRun(),
  });
}

/** Creates the Eval metadata that points the evaluator to the fixture's durable Turn. */
function completedRun(): EvalRunResult<ExecuteTurnResult> {
  return {
    caseId: 'excel-case',
    status: 'completed',
    durationMs: 1,
    metadata: { turnId: 'turn-1' },
  };
}

/** Creates a runtime-only result used to prove it is not read by the evaluator. */
function runtimeResult(tool: ToolResultMessage, assistant: AssistantMessage): ExecuteTurnResult {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    leafId: 'runtime-leaf',
    messages: [tool, assistant],
  };
}

/** Creates a runtime workbook-info message for the poisoned-result tests. */
function workbookInfoMessage(sheetCount: number): ToolResultMessage {
  return {
    role: 'tool',
    callId: 'runtime-workbook-call',
    name: 'get_workbook_info',
    content: [{ type: 'text', text: `sheetCount: ${sheetCount}` }],
    details: { sheetCount },
    isError: false,
  };
}

/** Creates a runtime assistant message for the poisoned-result tests. */
function assistantMessage(text: string): AssistantMessage {
  return {
    role: 'assistant',
    api: 'test-api',
    provider: 'test-provider',
    model: 'test-model',
    content: [{ type: 'text', text }],
    finishReason: 'stop',
  };
}

/** Creates a durable workbook-info attempt specification. */
function workbookInfoTool(sheetCount: number | undefined, isError = false): DurableToolSpec {
  return {
    name: 'get_workbook_info',
    isError,
    ...(sheetCount === undefined ? {} : { details: { sheetCount } }),
  };
}

/** Creates a durable sheet-profile attempt specification. */
function sheetProfileTool(
  sheetName: string | undefined,
  rowCount: number,
  isError = false,
): DurableToolSpec {
  return {
    name: 'get_sheet_profile',
    isError,
    ...(sheetName === undefined ? {} : { details: { sheetName, rowCount } }),
  };
}

/** Creates an intentionally malformed durable profile specification. */
function profileWithDetails(details: JsonValue): DurableToolSpec {
  return { name: 'get_sheet_profile', details };
}

/** Creates a durable aggregate attempt with optional completeness metadata. */
function aggregateDataTool(
  rows: readonly (readonly (string | number)[])[] = completeRegionalRows(),
  isError = false,
  options: { readonly resultRowCount?: number; readonly returnedRowCount?: number; readonly truncated?: boolean } = {},
): DurableToolSpec {
  return {
    name: 'aggregate_data',
    isError,
    details: aggregateDetails(rows, options),
  };
}

/** Creates an aggregate attempt with arbitrary structured details for invalid-shape tests. */
function aggregateWithDetails(details: JsonValue): DurableToolSpec {
  return { name: 'aggregate_data', details };
}

/** Creates an aggregate attempt whose durable resultDetails field is absent. */
function aggregateWithoutDetails(): DurableToolSpec {
  return { name: 'aggregate_data' };
}

/** Creates the structured aggregate details used by the Case 3 contract. */
function aggregateDetails(
  rows: readonly (readonly (string | number)[])[],
  options: { readonly resultRowCount?: number; readonly returnedRowCount?: number; readonly truncated?: boolean },
): JsonValue {
  return {
    sheetName: 'SalesData',
    columns: [
      { name: 'regionAlias', kind: 'group', sourceColumn: 'Region' },
      { name: 'amountAlias', kind: 'metric', sourceColumn: 'Revenue', operation: 'sum' },
      { name: 'countAlias', kind: 'metric', sourceColumn: 'OrderID', operation: 'count' },
    ],
    rows,
    sourceRowCount: 120,
    resultRowCount: options.resultRowCount ?? rows.length,
    returnedRowCount: options.returnedRowCount ?? rows.length,
    truncated: options.truncated ?? false,
  };
}

/** Returns the fixed regional rows from the Excel Golden workbook. */
function completeRegionalRows(): (string | number)[][] {
  return [
    ['North', 56067.46, 25],
    ['South', 92726.94, 40],
    ['East', 38655.38, 21],
    ['West', 58213.99, 34],
  ];
}
