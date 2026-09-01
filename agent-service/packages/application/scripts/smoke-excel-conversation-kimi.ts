import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import type { AgentMessage } from '@opspilot/agent-runtime';
import {
  createModelGateway,
  loadModelGatewayConfig,
  type AssistantMessage,
} from '@opspilot/model-gateway';
import { ExcelJsDiscoveryAdapter } from '@opspilot/tool-gateway';
import { Workbook } from 'exceljs';

import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  FileSystemSessionStore,
  RunConversationTurn,
  type AgentSessionEvent,
} from '../src/index.js';

const providerId = 'moonshot';
const modelId = 'kimi-k3';
const apiKeyEnvironmentVariable = 'MOONSHOT_API_KEY';
const envFilePath = fileURLToPath(new URL('../../../.env', import.meta.url));
const modelConfigPath = fileURLToPath(
  new URL('../../../config/model-providers.json', import.meta.url),
);

/** Runs a manual real-model Excel discovery smoke test; it is not part of the default test suite. */
async function main(): Promise<void> {
  if (existsSync(envFilePath)) loadEnvFile(envFilePath);
  if (!process.env[apiKeyEnvironmentVariable]?.trim()) {
    throw new Error('MOONSHOT_API_KEY is not configured.');
  }

  const gateway = createModelGateway(await loadModelGatewayConfig(modelConfigPath));
  const model = gateway.getModel(providerId, modelId);
  if (model === undefined) throw new Error(`Model ${providerId}/${modelId} is not configured.`);

  const directory = await mkdtemp(join(tmpdir(), 'opspilot-excel-smoke-'));
  try {
    const workbookPath = join(directory, 'fixture.xlsx');
    await createFixture(workbookPath);
    const sessionDirectory = join(directory, 'sessions');
    await mkdir(sessionDirectory);

    const toolEvents: string[] = [];
    const excelDiscoveryConnector = new ExcelJsDiscoveryAdapter();
    const runner = new RunConversationTurn({
      sessionStore: new FileSystemSessionStore(sessionDirectory),
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [
        createGetWorkbookInfoTool(excelDiscoveryConnector),
        createGetSheetProfileTool(excelDiscoveryConnector),
      ],
    });

    const result = await runner.execute(
      {
        message: userMessage('这个 Excel 有哪些工作表？请简要告诉我每个工作表的大概结构。'),
        excelResource: { id: 'manual-excel-smoke', filePath: workbookPath },
      },
      { onEvent: (event) => recordToolEvent(event, toolEvents) },
    );

    const assistant = [...result.messages]
      .reverse()
      .find((message): message is AssistantMessage => message.role === 'assistant');
    console.info(`[smoke] sessionId=${result.sessionId}`);
    console.info(`[smoke] tool events=${toolEvents.join(' -> ') || 'none'}`);
    console.info(`[smoke] final assistant text=${extractText(assistant)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function recordToolEvent(event: AgentSessionEvent, toolEvents: string[]): void {
  if (event.type !== 'tool_execution_start' && event.type !== 'tool_execution_end') return;
  toolEvents.push(`${event.type}:${event.toolCall.name}`);
  console.info(`[agent-event] ${event.type} tool=${event.toolCall.name}`);
}

function extractText(message: AssistantMessage | undefined): string {
  return message?.content
    .filter((content) => content.type === 'text')
    .map((content) => content.text)
    .join('') ?? '';
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

async function createFixture(filePath: string): Promise<void> {
  const workbook = new Workbook();
  workbook.addWorksheet('Sales').addRows([
    ['OrderId', 'Product', 'Quantity'],
    [1001, 'Keyboard', 2],
    [1002, 'Mouse', 3],
  ]);
  workbook.addWorksheet('Config').addRow(['Environment', 'Smoke']);
  await workbook.xlsx.writeFile(filePath);
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
