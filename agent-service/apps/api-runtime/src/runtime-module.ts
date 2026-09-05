import { DynamicModule } from '@nestjs/common';
import {
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  FileSystemSessionStore,
  GetConversationHistory,
  RunConversationTurn,
  type ToolDefinition,
} from '@opspilot/application';
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

  const sessionStore = new FileSystemSessionStore(config.sessionDirectory);
  const excelResourcePathResolver = new FileSystemExcelResourcePathResolver(
    config.sharedStorageRoot,
  );
  const runConversationTurn = new RunConversationTurn({
    sessionStore,
    modelGateway,
    defaultModel,
    toolDefinitions: createExcelDiscoveryToolDefinitions(),
  });
  const getConversationHistory = new GetConversationHistory(sessionStore);

  return ApiModule.register({
    providers: [
      { provide: RunConversationTurn, useValue: runConversationTurn },
      { provide: GetConversationHistory, useValue: getConversationHistory },
      { provide: EXCEL_RESOURCE_PATH_RESOLVER, useValue: excelResourcePathResolver },
    ],
    exports: [RunConversationTurn, GetConversationHistory, EXCEL_RESOURCE_PATH_RESOLVER],
  });
}
