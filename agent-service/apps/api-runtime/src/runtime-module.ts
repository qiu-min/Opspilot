import { DynamicModule } from '@nestjs/common';
import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  buildOpsPilotSystemPrompt,
  GetSessionHistory,
  ExecuteTurn,
  type ToolDefinition,
} from '@opspilot/application';
import { FileSystemSessionStore, FileSystemTurnStore } from '@opspilot/infrastructure';
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
  const turnStore = new FileSystemTurnStore(config.sharedStorageRoot);
  const excelResourcePathResolver = new FileSystemExcelResourcePathResolver(
    config.sharedStorageRoot,
  );
  const executeTurn = new ExecuteTurn({
    sessionStore,
    turnStore,
    modelGateway,
    defaultModel,
    toolDefinitions,
    systemPrompt,
  });
  const getSessionHistory = new GetSessionHistory(sessionStore);

  return ApiModule.register({
    providers: [
      { provide: ExecuteTurn, useValue: executeTurn },
      { provide: GetSessionHistory, useValue: getSessionHistory },
      { provide: EXCEL_RESOURCE_PATH_RESOLVER, useValue: excelResourcePathResolver },
    ],
    exports: [ExecuteTurn, GetSessionHistory, EXCEL_RESOURCE_PATH_RESOLVER],
  });
}
