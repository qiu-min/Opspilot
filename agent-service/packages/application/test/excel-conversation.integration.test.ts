import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { ExcelJsDiscoveryAdapter } from '@opspilot/tool-gateway';
import { Workbook } from 'exceljs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  FileSystemSessionStore,
  RunConversationTurn,
  type RunConversationTurnEvent,
} from '../src/index.js';

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

describe('Application Excel discovery conversation integration', () => {
  it('executes get_workbook_info through Agent Runtime and persists the real ExcelJS result', async () => {
    const { filePath, sessionDirectory } = await createFixture();
    const gateway = createGateway([
      assistantMessage('', [
        { callId: 'workbook-call', name: 'get_workbook_info', arguments: {} },
      ]),
      assistantMessage('The workbook contains Sales and Config.'),
    ]);
    const store = new FileSystemSessionStore(sessionDirectory);
    const runner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [createGetWorkbookInfoTool(new ExcelJsDiscoveryAdapter())],
    });
    const events: RunConversationTurnEvent[] = [];

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
    const runner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [createGetSheetProfileTool(new ExcelJsDiscoveryAdapter())],
    });
    const events: RunConversationTurnEvent[] = [];

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

  it('continues after get_workbook_info is called without an ExcelResource', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opspilot-application-missing-excel-e2e-'));
    directories.push(directory);
    const sessionDirectory = join(directory, 'sessions');
    await mkdir(sessionDirectory);

    const gateway = createGateway([
      assistantMessage('', [
        { callId: 'missing-resource-call', name: 'get_workbook_info', arguments: {} },
      ]),
      assistantMessage('Please attach an Excel workbook before I inspect it.'),
    ]);
    const store = new FileSystemSessionStore(sessionDirectory);
    const runner = new RunConversationTurn({
      sessionStore: store,
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [createGetWorkbookInfoTool(new ExcelJsDiscoveryAdapter())],
    });

    const result = await runner.execute({
      message: userMessage('Inspect the workbook.'),
    });

    expect(gateway.streamMock).toHaveBeenCalledTimes(2);
    expect(lastAssistantText(result.messages)).toBe(
      'Please attach an Excel workbook before I inspect it.',
    );
    const finalAssistant = [...result.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    expect(finalAssistant).toMatchObject({ finishReason: 'stop' });

    const toolResult = findToolResult(result.messages);
    expect(toolResult).toMatchObject({
      role: 'tool',
      name: 'get_workbook_info',
      isError: true,
      details: {
        kind: 'recoverable',
        code: 'EXCEL_RESOURCE_REQUIRED',
      },
    });
    expect(toolResult.content[0]?.text).toContain('No Excel workbook is attached');
    expect(gateway.requestedContexts[1]?.messages.at(-1)).toEqual(toolResult);

    const persistedMessages = store
      .load(result.sessionId)
      .getEntries()
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.message);
    expect(findToolResult(persistedMessages)).toMatchObject({
      role: 'tool',
      isError: true,
      details: {
        kind: 'recoverable',
        code: 'EXCEL_RESOURCE_REQUIRED',
      },
    });
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

function eventTypes(
  events: readonly RunConversationTurnEvent[],
): readonly RunConversationTurnEvent['type'][] {
  return events.map((event) => event.type);
}

async function createFixture(): Promise<{
  readonly filePath: string;
  readonly sessionDirectory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'opspilot-application-excel-e2e-'));
  directories.push(directory);

  const filePath = join(directory, 'fixture.xlsx');
  const workbook = new Workbook();
  const sales = workbook.addWorksheet('Sales');
  sales.addRows([
    ['OrderId', 'Product', 'Quantity'],
    [1001, 'Keyboard', 2],
    [1002, 'Mouse', 3],
  ]);
  const config = workbook.addWorksheet('Config');
  config.addRows([
    ['Environment', 'Test'],
  ]);
  await workbook.xlsx.writeFile(filePath);

  const sessionDirectory = join(directory, 'sessions');
  await mkdir(sessionDirectory);
  return { filePath, sessionDirectory };
}
