import { DynamicModule } from '@nestjs/common';
import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  buildOpsPilotSystemPrompt,
  createExcelToolPresentationResolver,
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
  /**一次业务层级别的 Turn实例：包括events.json和metadata.json，前者保存追加式执行事实，后者保存当前 Turn snapshot */
  const turnStore = new FileSystemTurnStore(config.turnStorageRoot);
  /** excution.json保存的是一次 Turn 恢复所需、但不属于 Domain Turn 的最小输入，目前主要是excel业务 */
  const turnExecutionContextStore = new FileSystemTurnExecutionContextStore(config.turnStorageRoot);
  /** Turn 流 hub，用于管理 Turn 的订阅和发布 进程重启丢失*/
  const turnStreamHub = new InMemoryTurnStreamHub();
  /**负责按 sessionId 串行化执行 同一个 Session：Turn 串行执行 不同 Session：可以并行执行*/
  const sessionRunCoordinator: SessionRunCoordinator = new InMemorySessionRunCoordinator();
  const excelResourcePathResolver = new FileSystemExcelResourcePathResolver(
    config.sharedStorageRoot,
  );
  const toolPresentationResolver = createExcelToolPresentationResolver();
  const executeTurn = new ExecuteTurn({
    sessionStore,
    turnStore,
    turnExecutionContextStore,
    modelGateway,
    defaultModel,
    toolDefinitions,
    systemPrompt,
    turnStreamHub,
    toolPresentationResolver,
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
    toolPresentationResolver,
  });
  const recoverTurnsOnStartup = new RecoverTurnsOnStartup({ turnStore, resumeTurn });
  const getSessionHistory = new GetSessionHistory({
    sessionStore,
    turnStore,
    toolPresentationResolver,
  });
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
