import { DynamicModule } from '@nestjs/common';
import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  buildOpsPilotSystemPrompt,
  GetActiveTurn,
  CreateSession,
  GetSessionHistory,
  ExecuteTurn,
  InMemorySessionRunCoordinator,
  RecoverTurnsOnStartup,
  ResumeTurn,
  type SessionRunCoordinator,
  SubscribeTurnStream,
  type ToolDefinition,
} from '@opspilot/application';
import {
  FileSystemSessionStore,
  FileSystemTurnStore,
  FileSystemTurnExecutionContextStore,
  InMemoryTurnStreamHub,
} from '@opspilot/infrastructure';
import { createModelGateway, loadModelGatewayConfig } from '@opspilot/model-gateway';
import { ExcelJsDiscoveryAdapter } from '@opspilot/tool-gateway';

import { ApiModule, EXCEL_RESOURCE_PATH_RESOLVER } from '@opspilot/api';
import { FileSystemExcelResourcePathResolver } from './files/excel-resource-path-resolver.js';
import type { RuntimeConfig } from './runtime-config.js';

/** Builds the only Excel tools exposed by this runtime composition root. */
export function createExcelDiscoveryToolDefinitions(): readonly ToolDefinition[] {
  const excelDiscoveryConnector = new ExcelJsDiscoveryAdapter();

  return [
    createGetWorkbookInfoTool(excelDiscoveryConnector),
    createGetSheetProfileTool(excelDiscoveryConnector),
  ];
}

export async function createApiRuntimeModule(config: RuntimeConfig): Promise<DynamicModule> {
  const modelGatewayConfig = await loadModelGatewayConfig(config.modelConfigPath);
  const modelGateway = createModelGateway(modelGatewayConfig);
  const defaultModel = modelGateway.getModel(config.defaultProviderId, config.defaultModelId);

  if (defaultModel === undefined) {
    throw new Error(
      `Default model ${config.defaultProviderId}/${config.defaultModelId} is not configured.`,
    );
  }

  const toolDefinitions = createExcelDiscoveryToolDefinitions();
  const systemPrompt = buildOpsPilotSystemPrompt({
    tools: toolDefinitions,
  });
  const sessionStore = new FileSystemSessionStore(config.sessionDirectory);
  const turnStore = new FileSystemTurnStore(config.turnStorageRoot);
  const turnExecutionContextStore = new FileSystemTurnExecutionContextStore(config.turnStorageRoot);
  const turnStreamHub = new InMemoryTurnStreamHub();
  const sessionRunCoordinator: SessionRunCoordinator = new InMemorySessionRunCoordinator();
  const excelResourcePathResolver = new FileSystemExcelResourcePathResolver(
    config.sharedStorageRoot,
  );
  const executeTurn = new ExecuteTurn({
    sessionStore,
    turnStore,
    turnExecutionContextStore,
    modelGateway,
    defaultModel,
    toolDefinitions,
    systemPrompt,
    turnStreamHub,
    sessionRunCoordinator,
  });
  const resumeTurn = new ResumeTurn({
    sessionStore,
    turnStore,
    turnExecutionContextStore,
    modelGateway,
    toolDefinitions,
    systemPrompt,
    sessionRunCoordinator,
    turnStreamHub,
  });
  const recoverTurnsOnStartup = new RecoverTurnsOnStartup({ turnStore, resumeTurn });
  const getSessionHistory = new GetSessionHistory(sessionStore);
  const createSession = new CreateSession(sessionStore);
  const getActiveTurn = new GetActiveTurn(turnStreamHub);
  const subscribeTurnStream = new SubscribeTurnStream(turnStreamHub);

  return ApiModule.register({
    providers: [
      { provide: ExecuteTurn, useValue: executeTurn },
      { provide: ResumeTurn, useValue: resumeTurn },
      { provide: RecoverTurnsOnStartup, useValue: recoverTurnsOnStartup },
      { provide: GetSessionHistory, useValue: getSessionHistory },
      { provide: CreateSession, useValue: createSession },
      { provide: GetActiveTurn, useValue: getActiveTurn },
      { provide: SubscribeTurnStream, useValue: subscribeTurnStream },
      { provide: EXCEL_RESOURCE_PATH_RESOLVER, useValue: excelResourcePathResolver },
    ],
    exports: [
      ExecuteTurn,
      GetSessionHistory,
      CreateSession,
      GetActiveTurn,
      SubscribeTurnStream,
      ResumeTurn,
      RecoverTurnsOnStartup,
      EXCEL_RESOURCE_PATH_RESOLVER,
    ],
  });
}
