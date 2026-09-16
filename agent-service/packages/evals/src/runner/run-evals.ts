import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadEnvFile } from 'node:process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOpsPilotSystemPrompt,
  createAggregateDataTool,
  createFilterDataTool,
  createGetSheetProfileTool,
  createGetWorkbookInfoTool,
  createReadRangeTool,
  createWriteDataTool,
  ExcelWorkingResourceManager,
  ExecuteTurn,
  GetTurnTrace,
  type ExecuteTurnResult,
  type ToolDefinition,
} from '@opspilot/application';
import {
  FileSystemExcelSourceResourceStore,
  FileSystemExcelWorkingResourceStore,
  FileSystemSessionStore,
  FileSystemTurnExecutionContextStore,
  FileSystemTurnStore,
} from '@opspilot/infrastructure';
import { createModelGateway, loadModelGatewayConfig } from '@opspilot/model-gateway';
import {
  ExcelJsAggregateAdapter,
  ExcelJsDataAdapter,
  ExcelJsDiscoveryAdapter,
  ExcelJsFilterAdapter,
} from '@opspilot/tool-gateway';

import {
  AgentEvalExecutor,
  ConsoleReporter,
  EvalRunner,
  ExcelWorkbookCorrectnessEvaluator,
  JsonReporter,
  RunCompletedEvaluator,
  TraceBehaviorEvaluator,
  WorkbookMutationEvaluator,
  loadExcelCases,
  type AgentEvalInput,
  type EvalCase,
  type WorkbookMutationReader,
} from '../index.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const defaultModelConfigPath = fileURLToPath(
  new URL('../../../../config/model-providers.json', import.meta.url),
);
const localEnvironmentPath = fileURLToPath(new URL('../../../../.env', import.meta.url));
const datasetPath = fileURLToPath(new URL('../../datasets/smoke/cases.json', import.meta.url));
const resultPath = resolve(packageRoot, 'results/eval-report.json');

/** Builds a real Application Turn executor using isolated temporary persistence. */
async function createApplicationExecutor(modelConfigPath: string): Promise<{
  readonly executeTurn: ExecuteTurn;
  readonly getTurnTrace: GetTurnTrace;
  readonly turnStore: FileSystemTurnStore;
  readonly sessionStore: FileSystemSessionStore;
  readonly workbookMutationReader: WorkbookMutationReader;
  readonly cleanup: () => Promise<void>;
}> {
  const config = await loadModelGatewayConfig(modelConfigPath);
  const modelGateway = createModelGateway(config);
  const providerId =
    optionalEnvironmentValue('EVAL_MODEL_PROVIDER') ??
    optionalEnvironmentValue('DEFAULT_MODEL_PROVIDER') ??
    config.providers[0]?.id;
  if (providerId === undefined) throw new Error('No Eval model provider is configured.');
  const modelId =
    optionalEnvironmentValue('EVAL_MODEL_ID') ??
    optionalEnvironmentValue('DEFAULT_MODEL_ID') ??
    config.providers.find((provider) => provider.id === providerId)?.models[0]?.id;
  if (modelId === undefined) throw new Error(`No model is configured for provider ${providerId}.`);

  const defaultModel = modelGateway.getModel(providerId, modelId);
  if (defaultModel === undefined) {
    throw new Error(`Eval model ${providerId}/${modelId} is not registered in the model gateway.`);
  }

  const storageRoot = await mkdtemp(join(tmpdir(), 'opspilot-evals-'));
  const workspaceStorageRoot = join(storageRoot, 'workspaces');
  const excelWorkingResourceStore = new FileSystemExcelWorkingResourceStore(workspaceStorageRoot);
  const excelWorkingResourceManager = new ExcelWorkingResourceManager({
    store: excelWorkingResourceStore,
    fileOperator: excelWorkingResourceStore,
  });
  const toolDefinitions = createExcelToolDefinitions(excelWorkingResourceManager);
  const workbookMutationReader = createWorkbookMutationReader(excelWorkingResourceStore);
  const turnStore = new FileSystemTurnStore(storageRoot);
  const sessionStore = new FileSystemSessionStore(join(storageRoot, 'sessions'));
  const executeTurn = new ExecuteTurn({
    sessionStore,
    excelSourceResourceStore: new FileSystemExcelSourceResourceStore(workspaceStorageRoot),
    turnStore,
    turnExecutionContextStore: new FileSystemTurnExecutionContextStore(storageRoot),
    modelGateway,
    defaultModel,
    toolDefinitions,
    systemPrompt: buildOpsPilotSystemPrompt({ tools: toolDefinitions }),
  });
  const getTurnTrace = new GetTurnTrace({ turnStore });

  return {
    executeTurn,
    getTurnTrace,
    turnStore,
    sessionStore,
    workbookMutationReader,
    cleanup: async () => await rm(storageRoot, { recursive: true, force: true }),
  };
}

/** Composes the evaluator reader over the committed working-resource store and Excel adapter. */
function createWorkbookMutationReader(
  workingResourceStore: FileSystemExcelWorkingResourceStore,
): WorkbookMutationReader {
  const excelDataConnector = new ExcelJsDataAdapter();
  return {
    async readRange({ sessionId, resourceId, sheetName, range }) {
      const resource = await workingResourceStore.get(sessionId, resourceId);
      if (resource === null) return null;
      const result = await excelDataConnector.readRange({
        filePath: resource.workingPath,
        sheetName,
        range,
      });
      return result.values;
    },
  };
}

/** Builds the same production Excel tool set inside the Eval composition root. */
function createExcelToolDefinitions(
  workingResourceManager: Pick<
    ExcelWorkingResourceManager,
    'resolveReadablePath' | 'executeMutation'
  >,
): readonly ToolDefinition[] {
  const excelDiscoveryConnector = new ExcelJsDiscoveryAdapter();
  const excelDataConnector = new ExcelJsDataAdapter();
  const excelAggregateConnector = new ExcelJsAggregateAdapter();
  const excelFilterConnector = new ExcelJsFilterAdapter();

  return [
    createGetWorkbookInfoTool(excelDiscoveryConnector, workingResourceManager),
    createGetSheetProfileTool(excelDiscoveryConnector, workingResourceManager),
    createAggregateDataTool(excelAggregateConnector, workingResourceManager),
    createFilterDataTool(excelFilterConnector, workingResourceManager),
    createReadRangeTool(excelDataConnector, workingResourceManager),
    createWriteDataTool(excelDataConnector, workingResourceManager),
  ];
}

/** Reads and validates the small checked-in smoke dataset at the runner boundary. */
async function loadSmokeCases(): Promise<readonly EvalCase<AgentEvalInput, unknown>[]> {
  const raw = JSON.parse(await readFile(datasetPath, 'utf8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('Smoke dataset must be an array.');

  return raw.map((value, index) => {
    if (!isRecord(value)) throw new Error(`Smoke dataset case ${index} must be an object.`);
    if (
      !isNonEmptyString(value.id) ||
      !isNonEmptyString(value.name) ||
      typeof value.input !== 'string'
    ) {
      throw new Error(`Smoke dataset case ${index} must contain string id, name, and input.`);
    }
    if (
      value.tags !== undefined &&
      (!Array.isArray(value.tags) || !value.tags.every((tag) => isNonEmptyString(tag)))
    ) {
      throw new Error(`Smoke dataset case ${index} tags must be non-empty strings.`);
    }
    return {
      id: value.id,
      name: value.name,
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      input: value.input,
      ...(value.tags === undefined ? {} : { tags: value.tags }),
    } satisfies EvalCase<string, unknown>;
  });
}

/** Runs the dataset, prints both reporters, and leaves a non-zero code for failed scores. */
async function main(): Promise<void> {
  loadLocalEnvironment();
  const modelConfigPath =
    optionalEnvironmentValue('EVAL_MODEL_CONFIG_PATH') ??
    optionalEnvironmentValue('MODEL_CONFIG_PATH');
  const application = await createApplicationExecutor(modelConfigPath ?? defaultModelConfigPath);
  try {
    const executor = new AgentEvalExecutor({ executeTurn: application.executeTurn });
    const smokeRunner = new EvalRunner<AgentEvalInput, unknown, ExecuteTurnResult>({
      executor,
      evaluators: [new RunCompletedEvaluator<ExecuteTurnResult>()],
    });
    const excelRunner = new EvalRunner<AgentEvalInput, unknown, ExecuteTurnResult>({
      executor,
      evaluators: [
        new RunCompletedEvaluator<ExecuteTurnResult>(),
        new ExcelWorkbookCorrectnessEvaluator({
          turns: application.turnStore,
          sessions: application.sessionStore,
        }),
        new WorkbookMutationEvaluator({
          turns: application.turnStore,
          workbook: application.workbookMutationReader,
        }),
        new TraceBehaviorEvaluator({ getTurnTrace: application.getTurnTrace }),
      ],
    });
    const reports = [
      ...(await smokeRunner.runAll(await loadSmokeCases())),
      ...(await excelRunner.runAll(await loadExcelCases())),
    ];

    process.stdout.write(`${new ConsoleReporter().render(reports)}\n`);
    await new JsonReporter().writeFile(resultPath, reports);
    process.stdout.write(`JSON report: ${resultPath}\n`);
    if (reports.some((report) => !report.passed)) process.exitCode = 1;
  } finally {
    await application.cleanup();
  }
}

/** Follows the existing Agent Service convention for local, gitignored environment files. */
function loadLocalEnvironment(): void {
  if (existsSync(localEnvironmentPath)) loadEnvFile(localEnvironmentPath);
}

/** Returns a record-shaped value for validating the JSON dataset without `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates required dataset strings before they become EvalCase identifiers or prompts. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Matches the existing runtime config behavior for optional blank environment variables. */
function optionalEnvironmentValue(name: string): string | undefined {
  const value = process.env[name];
  return isNonEmptyString(value) ? value : undefined;
}

await main();
