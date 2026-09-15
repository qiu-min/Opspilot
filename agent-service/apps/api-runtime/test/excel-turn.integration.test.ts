import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { AgentMessage } from '@opspilot/agent-runtime';
import {
  createModelEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type ModelEventStream,
  type ModelGateway,
  type ModelToolCall,
  type Options,
  type ToolResultMessage,
} from '@opspilot/model-gateway';
import {
  ExcelJsAggregateAdapter,
  ExcelJsDataAdapter,
  ExcelJsDiscoveryAdapter,
  ExcelJsFilterAdapter,
} from '@opspilot/tool-gateway';
import { Workbook } from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  createAggregateDataTool,
  createFilterDataTool,
  createReadRangeTool,
  createWriteDataTool,
  ExcelWorkingResourceManager,
  ExecuteTurn,
  ResumeTurn,
  Turn,
  TurnEventRecorder,
  createToolMutationId,
  type TurnExecutionEvent,
} from '@opspilot/application';
import {
  FileSystemExcelWorkingResourceStore,
  FileSystemExcelSourceResourceStore,
  FileSystemSessionStore,
  FileSystemTurnStore,
  FileSystemTurnExecutionContextStore,
} from '@opspilot/infrastructure';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  supportsTools: true,
  reasoning: false,
};

const directories: string[] = [];

interface FakeGateway extends ModelGateway {
  readonly requestedContexts: Context[];
  readonly requestedOptions: (Options | undefined)[];
  readonly streamMock: ReturnType<typeof vi.fn>;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Application Excel discovery Turn integration', () => {
  it('runs profile, aggregate, filter, and range reads against the committed revision', async () => {
    const { filePath, sessionDirectory } = await createSalesFixture();
    const sourceBefore = await readFile(filePath);
    const writeCall: ModelToolCall = {
      callId: 'prepare-working-revision',
      name: 'write_data',
      arguments: { sheetName: 'Sales', startCell: 'D1', data: [['Note'], ['Working copy']] },
    };
    const profileCall: ModelToolCall = {
      callId: 'profile-analysis',
      name: 'get_sheet_profile',
      arguments: { resource: 'excel-1', sheetName: 'Sales' },
    };
    const aggregateCall: ModelToolCall = {
      callId: 'aggregate-analysis',
      name: 'aggregate_data',
      arguments: {
        resource: 'excel-1',
        sheetName: 'Sales',
        groupBy: ['Region'],
        metrics: [{ column: 'Sales', operation: 'sum', alias: 'totalSales' }],
      },
    };
    const filterCall: ModelToolCall = {
      callId: 'filter-analysis',
      name: 'filter_data',
      arguments: {
        resource: 'excel-1',
        sheetName: 'Sales',
        conditions: [{ column: 'Sales', operator: 'greaterThan', value: 100 }],
      },
    };
    const readRangeCall: ModelToolCall = {
      callId: 'read-analysis-details',
      name: 'read_range',
      arguments: { resource: 'excel-1', sheetName: 'Sales', range: 'A1:D2' },
    };
    const harness = createExcelTurnHarness(
      sessionDirectory,
      join(dirname(filePath), 'workspaces'),
      [
        assistantMessage('', [writeCall]),
        assistantMessage('The working copy is ready.'),
        assistantMessage('', [profileCall]),
        assistantMessage('', [aggregateCall]),
        assistantMessage('', [filterCall]),
        assistantMessage('', [readRangeCall]),
        assistantMessage('North totals 400 and South totals 250; two rows exceed 100.'),
      ],
      true,
    );
    const executeMutation = vi.spyOn(harness.workingResourceManager, 'executeMutation');
    const getSheetProfile = vi.spyOn(harness.discoveryConnector, 'getSheetProfile');
    const aggregateData = vi.spyOn(harness.aggregateConnector, 'aggregateData');
    const filterData = vi.spyOn(harness.filterConnector, 'filterData');
    const readRange = vi.spyOn(harness.dataConnector, 'readRange');

    const prepared = await harness.runner.execute({
      message: userMessage('Prepare an analysis working copy.'),
      excelResource: { id: 'fixture-workbook', filePath },
    });
    const committed = await harness.workingResourceStore.get(
      prepared.sessionId,
      'fixture-workbook',
    );
    expect(committed).toMatchObject({ revision: 1, sourcePath: filePath });
    const mutationCountAfterWrite = executeMutation.mock.calls.length;

    const analyzed = await harness.runner.execute({
      sessionId: prepared.sessionId,
      message: userMessage('Analyze the Sales sheet by region and find rows over 100.'),
    });

    expect(lastAssistantText(analyzed.messages)).toBe(
      'North totals 400 and South totals 250; two rows exceed 100.',
    );
    expect(getSheetProfile).toHaveBeenCalledWith(
      { filePath: committed!.workingPath, sheetName: 'Sales' },
      expect.any(AbortSignal),
    );
    expect(aggregateData).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: committed!.workingPath,
        sheetName: 'Sales',
        groupBy: ['Region'],
      }),
      expect.any(AbortSignal),
    );
    expect(filterData).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: committed!.workingPath,
        sheetName: 'Sales',
        conditions: [{ column: 'Sales', operator: 'greaterThan', value: 100 }],
      }),
      expect.any(AbortSignal),
    );
    expect(readRange).toHaveBeenCalledWith(
      {
        filePath: committed!.workingPath,
        sheetName: 'Sales',
        range: 'A1:D2',
      },
      expect.any(AbortSignal),
    );
    expect(aggregateData.mock.calls[0]?.[0].filePath).toBe(committed!.workingPath);
    expect(filterData.mock.calls[0]?.[0].filePath).toBe(committed!.workingPath);
    expect(readRange.mock.calls[0]?.[0].filePath).toBe(committed!.workingPath);
    expect(executeMutation).toHaveBeenCalledTimes(mutationCountAfterWrite);
    expect(await harness.workingResourceStore.get(prepared.sessionId, 'fixture-workbook')).toEqual(
      committed,
    );
    expect(await readFile(filePath)).toEqual(sourceBefore);

    const persistedToolResults = new FileSystemSessionStore(sessionDirectory)
      .load(prepared.sessionId)
      .getEntries()
      .flatMap((entry) =>
        entry.type === 'message' && entry.message.role === 'tool' ? [entry.message] : [],
      );
    expect(findToolResultByName(persistedToolResults, 'get_sheet_profile').details).toMatchObject({
      sheetName: 'Sales',
    });
    expect(findToolResultByName(persistedToolResults, 'aggregate_data').details).toMatchObject({
      resultRowCount: 2,
      returnedRowCount: 2,
      truncated: false,
      rows: [
        ['North', 400],
        ['South', 250],
      ],
    });
    expect(findToolResultByName(persistedToolResults, 'filter_data').details).toMatchObject({
      matchedRowCount: 2,
      totalRangeCount: 1,
      returnedRangeCount: 1,
      truncated: false,
      matchedRanges: [{ startRow: 3, endRow: 4 }],
    });
    expect(findToolResultByName(persistedToolResults, 'read_range').details).toMatchObject({
      sheetName: 'Sales',
      range: 'A1:D2',
      rowCount: 2,
      columnCount: 4,
      cellCount: 8,
      values: [
        ['Region', 'Product', 'Sales', 'Note'],
        ['North', 'A', 100, 'Working copy'],
      ],
      truncatedCellValueCount: 0,
    });
    expect(persistedToolResults.map((message) => message.name).slice(-4)).toEqual([
      'get_sheet_profile',
      'aggregate_data',
      'filter_data',
      'read_range',
    ]);
    expect(analyzed.messages.some((message) => message.role === 'tool')).toBe(true);
    expect(new FileSystemTurnStore(sessionDirectory).load(analyzed.turnId).getState().status).toBe(
      'completed',
    );
  });

  it('executes get_workbook_info through Agent Runtime and persists the real ExcelJS result', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const gateway = createGateway([
      assistantMessage('', [{ callId: 'workbook-call', name: 'get_workbook_info', arguments: {} }]),
      assistantMessage('The workbook contains Sales and Config.'),
    ]);
    const store = new FileSystemSessionStore(sessionDirectory);
    const runner = new ExecuteTurn({
      sessionStore: store,
      excelSourceResourceStore: new FileSystemExcelSourceResourceStore(
        join(sessionDirectory, 'workspaces'),
      ),
      turnStore: new FileSystemTurnStore(sessionDirectory),
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [
        createGetWorkbookInfoTool(
          new ExcelJsDiscoveryAdapter(),
          createWorkingResourceManager(join(sessionDirectory, 'working-resources')),
        ),
      ],
    });
    const events: TurnExecutionEvent[] = [];

    const result = await runner.execute(
      {
        message: userMessage('Which worksheets does this workbook contain?'),
        excelResource: { id: 'fixture-workbook', filePath },
      },
      { onEvent: (event) => void events.push(event) },
    );

    expect(gateway.streamMock).toHaveBeenCalledTimes(2);
    expect(gateway.requestedContexts[0]?.tools?.map((tool) => tool.name)).toEqual([
      'get_workbook_info',
    ]);
    expect(lastAssistantText(result.messages)).toBe('The workbook contains Sales and Config.');

    const toolResult = findToolResult(result.messages);
    expect(toolResult.content[0]?.text).toContain('sheetCount: 2');
    expect(toolResult.content[0]?.text).toContain('name: Sales');
    expect(toolResult.content[0]?.text).toContain('name: Config');
    expect(toolResult.details).toMatchObject({
      sheetCount: 2,
      sheets: [
        expect.objectContaining({ name: 'Sales', usedRange: 'A1:C3' }),
        expect.objectContaining({ name: 'Config', usedRange: 'A1:B1' }),
      ],
    });
    expect(eventTypes(events)).toEqual(
      expect.arrayContaining(['tool_execution_start', 'tool_execution_end']),
    );

    const persistedMessages = store
      .load(result.sessionId)
      .getEntries()
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message);
    const persistedToolResult = findToolResult(persistedMessages);
    expect(persistedToolResult.details).toEqual(toolResult.details);
    expect(persistedToolResult.content).toEqual(toolResult.content);
  });

  it('executes get_sheet_profile through Agent Runtime with the requested sheet arguments', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const gateway = createGateway([
      assistantMessage('', [
        {
          callId: 'profile-call',
          name: 'get_sheet_profile',
          arguments: { sheetName: 'Sales', sampleSize: 10 },
        },
      ]),
      assistantMessage('Sales has OrderId, Product, and Quantity columns.'),
    ]);
    const store = new FileSystemSessionStore(sessionDirectory);
    const runner = new ExecuteTurn({
      sessionStore: store,
      excelSourceResourceStore: new FileSystemExcelSourceResourceStore(
        join(sessionDirectory, 'workspaces'),
      ),
      turnStore: new FileSystemTurnStore(sessionDirectory),
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [
        createGetSheetProfileTool(
          new ExcelJsDiscoveryAdapter(),
          createWorkingResourceManager(join(sessionDirectory, 'working-resources')),
        ),
      ],
    });
    const events: TurnExecutionEvent[] = [];

    const result = await runner.execute(
      {
        message: userMessage('Profile the Sales sheet.'),
        excelResource: { id: 'fixture-workbook', filePath },
      },
      { onEvent: (event) => void events.push(event) },
    );

    expect(gateway.streamMock).toHaveBeenCalledTimes(2);
    expect(lastAssistantText(result.messages)).toBe(
      'Sales has OrderId, Product, and Quantity columns.',
    );
    expect(gateway.requestedContexts[1]?.messages.at(-1)).toMatchObject({
      role: 'tool',
      callId: 'profile-call',
      name: 'get_sheet_profile',
      isError: false,
    });
    expect(gateway.requestedContexts[1]?.messages.at(-1)).toMatchObject({
      content: [
        {
          type: 'text',
          text: expect.stringContaining('letter: A; header: OrderId; inferredType: number'),
        },
      ],
    });

    const toolResult = findToolResult(result.messages);
    const profile = toolResult.details as {
      readonly sheetName: string;
      readonly usedRange: string;
      readonly rowCount: number;
      readonly columnCount: number;
      readonly headerRow: number;
      readonly sampledRowCount: number;
      readonly columns: readonly {
        readonly letter: string;
        readonly header: string | null;
        readonly inferredType: string;
      }[];
    };
    expect(profile).toMatchObject({
      sheetName: 'Sales',
      usedRange: 'A1:C3',
      rowCount: 3,
      columnCount: 3,
      headerRow: 1,
      sampledRowCount: 2,
    });
    expect(profile.columns).toEqual([
      expect.objectContaining({ letter: 'A', header: 'OrderId', inferredType: 'number' }),
      expect.objectContaining({ letter: 'B', header: 'Product', inferredType: 'string' }),
      expect.objectContaining({ letter: 'C', header: 'Quantity', inferredType: 'number' }),
    ]);
    expect(toolResult.content[0]?.text).toContain('sheetName: Sales');
    expect(toolResult.content[0]?.text).toContain('header: OrderId');
    expect(toolResult.content[0]?.text).toContain('header: Product');
    expect(toolResult.content[0]?.text).toContain('header: Quantity');
    expect(eventTypes(events)).toEqual(
      expect.arrayContaining(['tool_execution_start', 'tool_execution_end']),
    );
  });

  it('does not expose get_workbook_info without an ExcelResource', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opspilot-application-missing-excel-e2e-'));
    directories.push(directory);
    const sessionDirectory = join(directory, 'sessions');
    await mkdir(sessionDirectory);

    const gateway = createGateway([
      assistantMessage('Please attach an Excel workbook before I inspect it.'),
    ]);
    const store = new FileSystemSessionStore(sessionDirectory);
    const runner = new ExecuteTurn({
      sessionStore: store,
      excelSourceResourceStore: new FileSystemExcelSourceResourceStore(
        join(sessionDirectory, 'workspaces'),
      ),
      turnStore: new FileSystemTurnStore(sessionDirectory),
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [
        createGetWorkbookInfoTool(
          new ExcelJsDiscoveryAdapter(),
          createWorkingResourceManager(join(sessionDirectory, 'working-resources')),
        ),
      ],
    });

    const result = await runner.execute({
      message: userMessage('Inspect the workbook.'),
    });

    expect(gateway.streamMock).toHaveBeenCalledTimes(1);
    expect(lastAssistantText(result.messages)).toBe(
      'Please attach an Excel workbook before I inspect it.',
    );
    const finalAssistant = [...result.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    expect(finalAssistant).toMatchObject({ finishReason: 'stop' });
    expect(gateway.requestedContexts[0]?.tools).toEqual([]);
    expect(result.messages.some((message) => message.role === 'tool')).toBe(false);

    const persistedMessages = store
      .load(result.sessionId)
      .getEntries()
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message);
    expect(persistedMessages.some((message) => message.role === 'tool')).toBe(false);
  });
});

describe('Application Excel mutation Turn integration', () => {
  it('creates immutable committed revisions for later writes and reads the current workbook', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const workspaceRoot = join(dirname(filePath), 'workspaces');
    const firstWrite: ModelToolCall = {
      callId: 'write-region',
      name: 'write_data',
      arguments: {
        sheetName: 'Sales',
        startCell: 'D1',
        data: [['Region'], ['North']],
      },
    };
    const secondWrite: ModelToolCall = {
      callId: 'write-status',
      name: 'write_data',
      arguments: {
        sheetName: 'Sales',
        startCell: 'E1',
        data: [['Status'], ['Ready']],
      },
    };
    const profileCall: ModelToolCall = {
      callId: 'profile-after-write',
      name: 'get_sheet_profile',
      arguments: { sheetName: 'Sales' },
    };
    const harness = createExcelTurnHarness(sessionDirectory, workspaceRoot, [
      assistantMessage('', [firstWrite]),
      assistantMessage('Region data written.'),
      assistantMessage('', [secondWrite]),
      assistantMessage('Status data written.'),
      assistantMessage('', [profileCall]),
      assistantMessage('The worksheet now includes Region and Status.'),
    ]);
    const prepareMutation = vi.spyOn(harness.workingResourceStore, 'prepareMutation');
    const writeData = vi.spyOn(harness.dataConnector, 'writeData');
    const getSheetProfile = vi.spyOn(harness.discoveryConnector, 'getSheetProfile');

    const firstTurn = await harness.runner.execute({
      message: userMessage('Add the Region column.'),
      excelResource: { id: 'fixture-workbook', filePath },
    });
    const firstResource = await harness.workingResourceStore.get(
      firstTurn.sessionId,
      'fixture-workbook',
    );
    expect(firstResource?.revision).toBe(1);

    const secondTurn = await harness.runner.execute({
      sessionId: firstTurn.sessionId,
      message: userMessage('Add the Status column.'),
    });
    const secondResource = await harness.workingResourceStore.get(
      firstTurn.sessionId,
      'fixture-workbook',
    );
    expect(secondResource?.revision).toBe(2);
    expect(secondResource?.workingPath).not.toBe(firstResource?.workingPath);
    expect(prepareMutation).toHaveBeenCalledTimes(2);

    const readTurn = await harness.runner.execute({
      sessionId: firstTurn.sessionId,
      message: userMessage('Profile the updated worksheet.'),
    });
    expect(lastAssistantText(readTurn.messages)).toBe(
      'The worksheet now includes Region and Status.',
    );
    expect(writeData.mock.calls.map(([input]) => input.filePath)).toEqual([
      expect.stringContaining(join('resources', 'fixture-workbook', 'staging')),
      expect.stringContaining(join('resources', 'fixture-workbook', 'staging')),
    ]);
    expect(getSheetProfile).toHaveBeenCalledWith(
      { filePath: secondResource?.workingPath, sheetName: 'Sales' },
      expect.anything(),
    );
    expect(findToolResultByName(readTurn.messages, 'get_sheet_profile').details).toMatchObject({
      sheetName: 'Sales',
      columns: expect.arrayContaining([
        expect.objectContaining({ letter: 'D', header: 'Region' }),
        expect.objectContaining({ letter: 'E', header: 'Status' }),
      ]),
    });

    const workingWorkbook = new Workbook();
    await workingWorkbook.xlsx.readFile(secondResource!.workingPath);
    expect(workingWorkbook.getWorksheet('Sales')?.getCell('D1').value).toBe('Region');
    expect(workingWorkbook.getWorksheet('Sales')?.getCell('D2').value).toBe('North');
    expect(workingWorkbook.getWorksheet('Sales')?.getCell('E1').value).toBe('Status');
    expect(workingWorkbook.getWorksheet('Sales')?.getCell('E2').value).toBe('Ready');

    const sourceWorkbook = new Workbook();
    await sourceWorkbook.xlsx.readFile(filePath);
    expect(sourceWorkbook.getWorksheet('Sales')?.getCell('D1').value ?? null).toBeNull();
    expect(sourceWorkbook.getWorksheet('Sales')?.getCell('E1').value ?? null).toBeNull();
    expect(secondTurn.sessionId).toBe(firstTurn.sessionId);
  });

  it('treats the same Provider callId in a different Turn as a new mutation', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const workspaceRoot = join(dirname(filePath), 'workspaces');
    const call: ModelToolCall = {
      callId: 'duplicated-call',
      name: 'write_data',
      arguments: { sheetName: 'Sales', startCell: 'D1', data: [['Turn A']] },
    };
    const repeatedCall: ModelToolCall = {
      ...call,
      arguments: { sheetName: 'Sales', startCell: 'E1', data: [['Turn B']] },
    };
    const harness = createExcelTurnHarness(sessionDirectory, workspaceRoot, [
      assistantMessage('', [call]),
      assistantMessage('First write completed.'),
      assistantMessage('', [repeatedCall]),
      assistantMessage('Second write completed.'),
    ]);
    const executeMutation = vi.spyOn(harness.workingResourceManager, 'executeMutation');
    const writeData = vi.spyOn(harness.dataConnector, 'writeData');

    const first = await harness.runner.execute({
      message: userMessage('Write from the first Turn.'),
      excelResource: { id: 'fixture-workbook', filePath },
    });
    const second = await harness.runner.execute({
      sessionId: first.sessionId,
      message: userMessage('Write from the second Turn.'),
    });

    const mutationIds = executeMutation.mock.calls.map(([request]) => request.mutationId);
    expect(first.turnId).not.toBe(second.turnId);
    expect(mutationIds).toEqual([
      createToolMutationId(first.turnId, call.callId),
      createToolMutationId(second.turnId, call.callId),
    ]);
    expect(mutationIds[0]).not.toBe(mutationIds[1]);
    expect(writeData).toHaveBeenCalledTimes(2);
    expect(
      (await harness.workingResourceStore.get(first.sessionId, 'fixture-workbook'))?.revision,
    ).toBe(2);

    const current = await harness.workingResourceStore.get(first.sessionId, 'fixture-workbook');
    const workbook = new Workbook();
    await workbook.xlsx.readFile(current!.workingPath);
    expect(workbook.getWorksheet('Sales')?.getCell('D1').value).toBe('Turn A');
    expect(workbook.getWorksheet('Sales')?.getCell('E1').value).toBe('Turn B');
  });

  it('routes an explicit alias to its own working copy when another resource is active', async () => {
    const { filePath: filePathA, sessionDirectory } = await createFixture();
    const filePathB = join(dirname(filePathA), 'second-fixture.xlsx');
    await writeWorkbookFixture(filePathB);
    const workspaceRoot = join(dirname(filePathA), 'workspaces');
    const writeCall: ModelToolCall = {
      callId: 'write-only-a',
      name: 'write_data',
      arguments: {
        resource: 'excel-1',
        sheetName: 'Sales',
        startCell: 'D1',
        data: [['Only A']],
      },
    };
    const harness = createExcelTurnHarness(sessionDirectory, workspaceRoot, [
      assistantMessage('Workbook A attached.'),
      assistantMessage('Workbook B attached.'),
      assistantMessage('', [writeCall]),
      assistantMessage('Workbook A updated.'),
    ]);
    const writeData = vi.spyOn(harness.dataConnector, 'writeData');

    const firstTurn = await harness.runner.execute({
      message: userMessage('Attach workbook A.'),
      excelResource: { id: 'workbook-a', filePath: filePathA },
    });
    await harness.runner.execute({
      sessionId: firstTurn.sessionId,
      message: userMessage('Attach workbook B.'),
      excelResource: { id: 'workbook-b', filePath: filePathB },
    });
    await harness.runner.execute({
      sessionId: firstTurn.sessionId,
      message: userMessage('Write to workbook A.'),
    });

    const workingA = await harness.workingResourceStore.get(firstTurn.sessionId, 'workbook-a');
    const workingB = await harness.workingResourceStore.get(firstTurn.sessionId, 'workbook-b');
    expect(workingA).toMatchObject({ revision: 1, sourcePath: filePathA });
    expect(workingB).toBeNull();
    expect(writeData).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: expect.stringContaining(join('resources', 'workbook-a', 'staging')),
      }),
      expect.anything(),
    );

    const sourceA = new Workbook();
    const sourceB = new Workbook();
    await sourceA.xlsx.readFile(filePathA);
    await sourceB.xlsx.readFile(filePathB);
    expect(sourceA.getWorksheet('Sales')?.getCell('D1').value ?? null).toBeNull();
    expect(sourceB.getWorksheet('Sales')?.getCell('D1').value ?? null).toBeNull();

    const workingWorkbook = new Workbook();
    await workingWorkbook.xlsx.readFile(workingA!.workingPath);
    expect(workingWorkbook.getWorksheet('Sales')?.getCell('D1').value).toBe('Only A');
  });

  it('keeps working copies independent when separate Sessions write the same source resource', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const workspaceRoot = join(dirname(filePath), 'workspaces');
    const harness = createExcelTurnHarness(sessionDirectory, workspaceRoot, [
      assistantMessage('', [
        {
          callId: 'write-session-a',
          name: 'write_data',
          arguments: { sheetName: 'Sales', startCell: 'D1', data: [['Session A']] },
        },
      ]),
      assistantMessage('Session A updated.'),
      assistantMessage('', [
        {
          callId: 'write-session-b',
          name: 'write_data',
          arguments: { sheetName: 'Sales', startCell: 'D1', data: [['Session B']] },
        },
      ]),
      assistantMessage('Session B updated.'),
    ]);
    const prepareMutation = vi.spyOn(harness.workingResourceStore, 'prepareMutation');

    const sessionA = await harness.runner.execute({
      message: userMessage('Write for Session A.'),
      excelResource: { id: 'shared-resource', filePath },
    });
    const sessionB = await harness.runner.execute({
      message: userMessage('Write for Session B.'),
      excelResource: { id: 'shared-resource', filePath },
    });
    const workingA = await harness.workingResourceStore.get(sessionA.sessionId, 'shared-resource');
    const workingB = await harness.workingResourceStore.get(sessionB.sessionId, 'shared-resource');

    expect(sessionA.sessionId).not.toBe(sessionB.sessionId);
    expect(workingA?.revision).toBe(1);
    expect(workingB?.revision).toBe(1);
    expect(workingA?.workingPath).not.toBe(workingB?.workingPath);
    expect(prepareMutation).toHaveBeenCalledTimes(2);

    const workbookA = new Workbook();
    const workbookB = new Workbook();
    const source = new Workbook();
    await workbookA.xlsx.readFile(workingA!.workingPath);
    await workbookB.xlsx.readFile(workingB!.workingPath);
    await source.xlsx.readFile(filePath);
    expect(workbookA.getWorksheet('Sales')?.getCell('D1').value).toBe('Session A');
    expect(workbookB.getWorksheet('Sales')?.getCell('D1').value).toBe('Session B');
    expect(source.getWorksheet('Sales')?.getCell('D1').value ?? null).toBeNull();
  });

  it('keeps the source as current when the Excel Gateway write fails', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const workspaceRoot = join(dirname(filePath), 'workspaces');
    const harness = createExcelTurnHarness(sessionDirectory, workspaceRoot, []);
    const writeData = vi
      .spyOn(harness.dataConnector, 'writeData')
      .mockRejectedValue(new Error('Excel write failed.'));
    const context = {
      turnId: 'turn-write-failure',
      sessionId: 'session-write-failure',
      excelResources: [{ id: 'fixture-workbook', filePath }],
      excelResourceRefs: [{ id: 'fixture-workbook', kind: 'excel' as const, alias: 'excel-1' }],
      activeExcelResourceId: 'fixture-workbook',
    };
    const prepareMutation = vi.spyOn(harness.workingResourceManager, 'executeMutation');
    const writeTool = createWriteDataTool(harness.dataConnector, harness.workingResourceManager);

    await expect(
      writeTool.execute('failed-write', { data: [['value']] }, undefined, context),
    ).rejects.toThrow('Excel write failed.');

    const working = await harness.workingResourceStore.get(context.sessionId, 'fixture-workbook');
    expect(working).toBeNull();
    expect(prepareMutation).toHaveBeenCalledTimes(1);
    expect(writeData.mock.calls[0]?.[0].filePath).toContain(
      join('resources', 'fixture-workbook', 'staging'),
    );
  });

  it('replays a committed write_data receipt through ResumeTurn without a second Gateway write', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const workspaceRoot = join(dirname(filePath), 'workspaces');
    const sessionStore = new FileSystemSessionStore(sessionDirectory);
    const turnStore = new FileSystemTurnStore(sessionDirectory);
    const executionContextStore = new FileSystemTurnExecutionContextStore(sessionDirectory);
    const session = sessionStore.create();
    const modelChange = session.appendModelChange(model.provider, model.id);
    sessionStore.appendEntry(session.getId(), modelChange);
    const input = session.appendMessage(userMessage('Write the sales marker.'));
    sessionStore.appendEntry(session.getId(), input);

    const turn = Turn.create({ sessionId: session.getId(), baseLeafId: modelChange.id });
    turnStore.create(turn);
    turn.start();
    turnStore.save(turn);
    const recorder = new TurnEventRecorder(turn, turnStore, session);
    recorder.recordTurnStarted();
    recorder.recordInputCommitted(input.id, input.id);

    const call: ModelToolCall = {
      callId: 'retry-write-call',
      name: 'write_data',
      arguments: { sheetName: 'Sales', startCell: 'D1', data: [['Recovered once']] },
    };
    const assistantWithTool = assistantMessage('', [call]);
    const assistantEntry = session.appendMessage(assistantWithTool);
    sessionStore.appendEntry(session.getId(), assistantEntry);
    recorder.recordModelStarted('model-call-initial');
    recorder.recordModelCompleted('model-call-initial');
    recorder.recordAssistantMessageCompleted(assistantWithTool);
    recorder.recordToolRequested(call.callId, call.name);
    recorder.recordToolStarted(call.callId, call.name);
    executionContextStore.save(turn.getId(), {
      version: 1,
      excelResource: { id: 'fixture-workbook', filePath },
    });

    const workingResourceStore = new FileSystemExcelWorkingResourceStore(workspaceRoot);
    const workingResourceManager = new ExcelWorkingResourceManager({
      store: workingResourceStore,
      fileOperator: workingResourceStore,
    });
    const dataConnector = new ExcelJsDataAdapter();
    const writeData = vi.spyOn(dataConnector, 'writeData');
    const writeTool = createWriteDataTool(dataConnector, workingResourceManager);
    const executeMutation = vi.spyOn(workingResourceManager, 'executeMutation');
    const toolContext = {
      turnId: turn.getId(),
      sessionId: session.getId(),
      excelResources: [{ id: 'fixture-workbook', filePath }],
      excelResourceRefs: [{ id: 'fixture-workbook', kind: 'excel' as const, alias: 'excel-1' }],
      activeExcelResourceId: 'fixture-workbook',
    };

    const originalResult = await writeTool.execute(
      call.callId,
      call.arguments,
      undefined,
      toolContext,
    );
    expect(originalResult.details).toMatchObject({
      sheetName: 'Sales',
      range: 'D1:D1',
      message: 'Data written to Sales',
    });
    expect((await workingResourceStore.get(session.getId(), 'fixture-workbook'))?.revision).toBe(1);
    expect(
      turnStore.loadEvents(turn.getId()).some((event) => event.type === 'tool_completed'),
    ).toBe(false);

    const persistedExecutionInput = JSON.parse(
      await readFile(join(sessionDirectory, 'turns', turn.getId(), 'execution.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(persistedExecutionInput).toEqual({
      version: 1,
      excelResource: { id: 'fixture-workbook', filePath },
    });

    const recoveryGateway = createGateway([assistantMessage('The write is complete.')]);
    const result = await new ResumeTurn({
      sessionStore,
      turnStore,
      turnExecutionContextStore: executionContextStore,
      modelGateway: recoveryGateway,
      toolDefinitions: [writeTool],
    }).execute(turn.getId());

    const recoveredSession = sessionStore.load(session.getId());
    const toolResults = recoveredSession
      .getEntries()
      .filter((entry) => entry.type === 'message' && entry.message.role === 'tool');
    const recoveredEvents = turnStore.loadEvents(turn.getId());
    const recoveredTurn = turnStore.load(turn.getId());
    expect(result.kind).toBe('resumed');
    expect(result.plan?.kind).toBe('resume_tools');
    expect(writeData).toHaveBeenCalledTimes(1);
    expect(executeMutation.mock.calls.map(([request]) => request.mutationId)).toEqual([
      createToolMutationId(turn.getId(), call.callId),
      createToolMutationId(turn.getId(), call.callId),
    ]);
    expect(recoveryGateway.streamMock).toHaveBeenCalledTimes(1);
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({
      type: 'message',
      message: {
        role: 'tool',
        callId: call.callId,
        details: originalResult.details,
      },
    });
    expect(recoveredEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_completed', callId: call.callId, isError: false }),
      ]),
    );
    const latestAssistantEvent = [...recoveredEvents]
      .reverse()
      .find((event) => event.type === 'assistant_message_completed');
    expect(recoveredTurn.getState()).toMatchObject({
      status: 'completed',
      attempt: 2,
      checkpoint: {
        phase: 'assistant_committed',
        eventSequence: latestAssistantEvent?.sequence,
      },
    });
    expect((await workingResourceStore.get(session.getId(), 'fixture-workbook'))?.revision).toBe(1);
  });
});

function createGateway(responses: readonly AssistantMessage[]): FakeGateway {
  let responseIndex = 0;
  const requestedContexts: Context[] = [];
  const requestedOptions: (Options | undefined)[] = [];
  const stream = vi.fn((_requestedModel: Model, context: Context, options?: Options) => {
    requestedContexts.push(context);
    requestedOptions.push(options);
    const response = responses[responseIndex++];
    if (response === undefined) throw new Error('Unexpected extra model call.');
    return assistantStream(response);
  });

  return {
    getProviders: () => [],
    getModels: () => [model],
    getModel: (provider, id) =>
      provider === model.provider && id === model.id ? model : undefined,
    stream: stream as unknown as ModelGateway['stream'],
    complete: async () => {
      throw new Error('complete is not used by this integration test.');
    },
    requestedContexts,
    requestedOptions,
    streamMock: stream,
  };
}

function assistantStream(message: AssistantMessage): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

function assistantMessage(text: string, toolCalls?: readonly ModelToolCall[]): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: text.length === 0 ? [] : [{ type: 'text', text }],
    finishReason: toolCalls === undefined ? 'stop' : 'tool_calls',
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function findToolResult(messages: readonly AgentMessage[]): ToolResultMessage {
  const toolResult = messages.find(
    (message): message is ToolResultMessage => message.role === 'tool',
  );
  if (toolResult === undefined) throw new Error('Expected a ToolResultMessage.');
  return toolResult;
}

function findToolResultByName(
  messages: readonly AgentMessage[],
  toolName: string,
): ToolResultMessage {
  const toolResult = [...messages]
    .reverse()
    .find(
      (message): message is ToolResultMessage =>
        message.role === 'tool' && message.name === toolName,
    );
  if (toolResult === undefined) throw new Error(`Expected a ${toolName} ToolResultMessage.`);
  return toolResult;
}

function lastAssistantText(messages: readonly AgentMessage[]): string {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant');
  if (assistant === undefined || assistant.role !== 'assistant') {
    throw new Error('Expected assistant message.');
  }
  return assistant.content
    .filter(
      (content): content is { readonly type: 'text'; readonly text: string } =>
        content.type === 'text',
    )
    .map((content) => content.text)
    .join('');
}

function eventTypes(events: readonly TurnExecutionEvent[]): readonly TurnExecutionEvent['type'][] {
  return events.map((event) => event.type);
}

async function createFixture(): Promise<{
  readonly filePath: string;
  readonly sessionDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'opspilot-application-excel-e2e-'));
  directories.push(directory);

  const filePath = join(directory, 'fixture.xlsx');
  await writeWorkbookFixture(filePath);

  const sessionDirectory = join(directory, 'sessions');
  await mkdir(sessionDirectory);
  return { filePath, sessionDirectory };
}

async function writeWorkbookFixture(filePath: string): Promise<void> {
  const workbook = new Workbook();
  const sales = workbook.addWorksheet('Sales');
  sales.addRows([
    ['OrderId', 'Product', 'Quantity'],
    [1001, 'Keyboard', 2],
    [1002, 'Mouse', 3],
  ]);
  const config = workbook.addWorksheet('Config');
  config.addRows([['Environment', 'Test']]);
  await workbook.xlsx.writeFile(filePath);
}

function createExcelTurnHarness(
  sessionDirectory: string,
  workspaceRoot: string,
  responses: readonly AssistantMessage[],
  includeAnalysisTools = false,
) {
  const gateway = createGateway(responses);
  const workingResourceStore = new FileSystemExcelWorkingResourceStore(workspaceRoot);
  const workingResourceManager = new ExcelWorkingResourceManager({
    store: workingResourceStore,
    fileOperator: workingResourceStore,
  });
  const dataConnector = new ExcelJsDataAdapter();
  const discoveryConnector = new ExcelJsDiscoveryAdapter();
  const aggregateConnector = new ExcelJsAggregateAdapter();
  const filterConnector = new ExcelJsFilterAdapter();
  const runner = new ExecuteTurn({
    sessionStore: new FileSystemSessionStore(sessionDirectory),
    excelSourceResourceStore: new FileSystemExcelSourceResourceStore(workspaceRoot),
    turnStore: new FileSystemTurnStore(sessionDirectory),
    modelGateway: gateway,
    defaultModel: model,
    toolDefinitions: [
      createGetWorkbookInfoTool(discoveryConnector, workingResourceManager),
      createGetSheetProfileTool(discoveryConnector, workingResourceManager),
      ...(includeAnalysisTools
        ? [
            createAggregateDataTool(aggregateConnector, workingResourceManager),
            createFilterDataTool(filterConnector, workingResourceManager),
            createReadRangeTool(dataConnector, workingResourceManager),
          ]
        : []),
      createWriteDataTool(dataConnector, workingResourceManager),
    ],
  });

  return {
    runner,
    gateway,
    workingResourceStore,
    workingResourceManager,
    dataConnector,
    discoveryConnector,
    aggregateConnector,
    filterConnector,
  };
}

async function createSalesFixture(): Promise<{
  readonly filePath: string;
  readonly sessionDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'opspilot-application-excel-analysis-e2e-'));
  directories.push(directory);
  const filePath = join(directory, 'sales.xlsx');
  const workbook = new Workbook();
  const sales = workbook.addWorksheet('Sales');
  sales.addRows([
    ['Region', 'Product', 'Sales'],
    ['North', 'A', 100],
    ['South', 'B', 250],
    ['North', 'C', 300],
  ]);
  await workbook.xlsx.writeFile(filePath);
  const sessionDirectory = join(directory, 'sessions');
  await mkdir(sessionDirectory);
  return { filePath, sessionDirectory };
}

function createWorkingResourceManager(workspaceRoot: string): ExcelWorkingResourceManager {
  const store = new FileSystemExcelWorkingResourceStore(workspaceRoot);
  return new ExcelWorkingResourceManager({ store, fileOperator: store });
}
