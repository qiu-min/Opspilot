import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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

import {
  FileSystemSessionStore,
  RunConversationTurn,
  type RunConversationTurnEvent,
  type RunConversationTurnResult,
  SessionManager,
} from '../src/index.js';

const PROVIDER_ID = 'moonshot';
const MODEL_ID = 'kimi-k3';
const API_KEY_ENV = 'MOONSHOT_API_KEY';
const WATCHDOG_TIMEOUT_MS = 60_000;
const envFilePath = fileURLToPath(new URL('../../../.env', import.meta.url));
const modelConfigPath = fileURLToPath(
  new URL('../../../config/model-providers.json', import.meta.url),
);

type ErrorRecord = Record<string, unknown>;
type DiagnosticWriter = (message: string) => void;
type TurnLabel = 'first' | 'second';

/** Loads the agent-service-local environment file when it is available. */
function loadLocalEnvironment(): void {
  if (existsSync(envFilePath)) loadEnvFile(envFilePath);
}

/** Returns an object-like view of an unknown value. */
function asRecord(value: unknown): ErrorRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as ErrorRecord) : undefined;
}

/** Redacts the configured key and common credential-shaped values from diagnostics. */
function redactSensitiveText(value: string): string {
  const configuredApiKey = process.env[API_KEY_ENV];
  let safeValue = configuredApiKey ? value.replaceAll(configuredApiKey, '[redacted]') : value;
  safeValue = safeValue.replace(
    /(["']?authorization["']?\s*[:=]\s*["']?(?:bearer\s+)?)[^"'\s,;}]+/giu,
    '$1[redacted]',
  );
  return safeValue.replace(
    /(["']?(?:api[-_ ]?key|secret|token)["']?\s*[:=]\s*["']?)[^"'\s,;}]+/giu,
    '$1[redacted]',
  );
}

/** Converts an error or state value to one-line, secret-safe diagnostic text. */
function formatDiagnosticValue(value: unknown): string {
  if (value === undefined) return 'none';
  if (value instanceof Error)
    return redactSensitiveText(`${value.name}: ${value.message || '(no message)'}`);
  if (typeof value === 'string') return redactSensitiveText(value);
  try {
    return redactSensitiveText(JSON.stringify(value) ?? String(value));
  } catch {
    return redactSensitiveText(String(value));
  }
}

/** Summarizes a message without printing its content or other potentially large fields. */
function summarizeMessage(message: AgentMessage | undefined): string {
  if (message === undefined) return 'none';
  const messageRecord = asRecord(message);
  const content = Array.isArray(messageRecord?.content) ? messageRecord.content : [];
  const contentTypes = content
    .map((item) => {
      const record = asRecord(item);
      return typeof record?.type === 'string' ? record.type : 'unknown';
    })
    .join(',');
  const role = typeof messageRecord?.role === 'string' ? messageRecord.role : 'unknown';
  return `role=${role} contentType=${contentTypes || 'none'}`;
}

/** Records each Application event while keeping high-frequency updates compact. */
function recordApplicationEvent(
  turn: TurnLabel,
  event: RunConversationTurnEvent,
  events: string[],
  setLastEvent: (value: string) => void,
): void {
  const observed = `${turn}:${event.type}`;
  events.push(event.type);
  setLastEvent(observed);

  if (
    event.type === 'message_start' ||
    event.type === 'message_update' ||
    event.type === 'message_end'
  ) {
    console.info(`[agent-event] ${observed} ${summarizeMessage(event.message)}`);
    return;
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    console.info(`[agent-event] ${observed} tool=${event.toolCall.name}`);
    return;
  }
  if (event.type === 'compaction_start' || event.type === 'compaction_end') {
    console.info(`[agent-event] ${observed} reason=${event.reason}`);
    return;
  }
  if (event.type === 'session_ready') {
    console.info(`[agent-event] ${observed} sessionId=${event.sessionId} created=${event.created}`);
    return;
  }
  console.info(`[agent-event] ${observed}`);
}

/** Extracts only user-visible text content from an assistant message. */
function extractText(message: AssistantMessage): string {
  return message.content.map((content) => (content.type === 'text' ? content.text : '')).join('');
}

/** Finds the last assistant without depending on the returned array's final index. */
function findLastAssistant(messages: readonly AgentMessage[]): AssistantMessage | undefined {
  return [...messages].reverse().find((message): message is AssistantMessage => {
    return message.role === 'assistant';
  });
}

/** Prints persisted SessionManager facts without dumping the JSONL contents. */
function logSessionManagerSummary(sessionManager: SessionManager, write: DiagnosticWriter): void {
  const entries = sessionManager.getEntries();
  const branchEntries = sessionManager.getBranch();
  write(`[smoke] persisted header.id=${sessionManager.getHeader().id}`);
  write(`[smoke] persisted entry count=${entries.length}`);
  write(`[smoke] persisted branch entry count=${branchEntries.length}`);
  write(`[smoke] persisted leafId=${sessionManager.getLeafId() ?? 'none'}`);
  write(`[smoke] persisted entry types=${entries.map((entry) => entry.type).join(' -> ')}`);
}

/** Prints the final context projection and verifies both turns are represented. */
function logAndValidateFinalContext(
  sessionManager: SessionManager,
  firstPrompt: string,
  secondPrompt: string,
): void {
  const context = sessionManager.buildSessionContext();
  const userMessages = context.messages.filter((message) => message.role === 'user');
  const assistantMessages = context.messages.filter((message) => message.role === 'assistant');
  const userText = (message: AgentMessage): string =>
    message.role === 'user' ? message.content.map((content) => content.text).join('') : '';

  console.info(`[smoke] final context message count=${context.messages.length}`);
  console.info(`[smoke] final context model=${formatDiagnosticValue(context.model)}`);
  console.info(`[smoke] final context thinkingLevel=${context.thinkingLevel}`);
  console.info(
    `[smoke] final context has first user=${userMessages.some((message) => userText(message) === firstPrompt)}`,
  );
  console.info(
    `[smoke] final context has second user=${userMessages.some((message) => userText(message) === secondPrompt)}`,
  );
  console.info(`[smoke] final context assistant count=${assistantMessages.length}`);

  if (!userMessages.some((message) => userText(message) === firstPrompt))
    throw new Error('Final Session context is missing the first user message.');
  if (!userMessages.some((message) => userText(message) === secondPrompt))
    throw new Error('Final Session context is missing the second user message.');
  if (assistantMessages.length < 2)
    throw new Error('Final Session context is missing one or more assistant messages.');
}

/** Prints filesystem state and reload diagnostics when a turn watchdog fires. */
function logWatchdogDiagnostics(
  tempSessionDirectory: string,
  sessionStore: FileSystemSessionStore,
  knownSessionId: string | undefined,
  turn: TurnLabel,
  currentStage: string,
  lastObservedEvent: string | undefined,
  elapsedMs: number,
): void {
  console.error(`[smoke] ${turn} turn did not resolve within ${WATCHDOG_TIMEOUT_MS}ms`);
  console.error(`[smoke] current stage=${currentStage}`);
  console.error(`[smoke] last observed event=${lastObservedEvent ?? 'none'}`);
  console.error(`[smoke] elapsedMs=${elapsedMs}`);
  console.error(`[smoke] temp session directory=${tempSessionDirectory}`);
  console.error(`[smoke] known sessionId=${knownSessionId ?? 'none'}`);
  let files = 'unavailable';
  try {
    files = readdirSync(tempSessionDirectory).join(', ') || 'none';
  } catch (error: unknown) {
    files = `unavailable (${formatDiagnosticValue(error)})`;
  }
  console.error(`[smoke] filesystem entries/files=${files}`);

  if (knownSessionId === undefined) return;
  try {
    logSessionManagerSummary(sessionStore.load(knownSessionId), (message) =>
      console.error(message),
    );
  } catch (error: unknown) {
    console.error(`[smoke] watchdog reload error=${formatDiagnosticValue(error)}`);
  }
}

/** Runs one turn with a diagnostic-only 60-second Promise.race watchdog. */
async function executeWithWatchdog(
  operation: Promise<RunConversationTurnResult>,
  turn: TurnLabel,
  onTimeout: () => void,
): Promise<RunConversationTurnResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(
        new Error(
          `${turn} RunConversationTurn.execute() did not resolve within ${WATCHDOG_TIMEOUT_MS}ms`,
        ),
      );
    }, WATCHDOG_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Prints safe error metadata and the latest filesystem/session diagnostics. */
function logFailure(
  error: unknown,
  currentStage: string,
  lastObservedEvent: string | undefined,
  tempSessionDirectory: string | undefined,
  sessionStore: FileSystemSessionStore | undefined,
  knownSessionId: string | undefined,
  elapsedMs: number,
): void {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const nestedError = asRecord(record?.error);
  const cause = record?.cause;
  const causeRecord = asRecord(cause);
  const errorName = error instanceof Error ? error.name : record?.name;
  const errorMessage = error instanceof Error ? error.message : record?.message;
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[smoke] error name=${formatDiagnosticValue(errorName ?? 'UnknownError')}`);
  console.error(`[smoke] error message=${formatDiagnosticValue(errorMessage ?? String(error))}`);
  console.error(`[smoke] error cause=${formatDiagnosticValue(cause)}`);
  console.error(`[smoke] stack=${formatDiagnosticValue(stack)}`);

  const diagnosticSources = [record, response, nestedError, causeRecord];
  for (const field of ['status', 'statusCode', 'code'] as const) {
    const source = diagnosticSources.find((candidate) => candidate?.[field] !== undefined);
    if (source) console.error(`[smoke] error ${field}=${formatDiagnosticValue(source[field])}`);
  }

  const responseBody =
    record?.responseBody ??
    record?.body ??
    response?.body ??
    response?.data ??
    nestedError?.body ??
    nestedError?.message;
  if (responseBody !== undefined)
    console.error(`[smoke] error responseBody=${formatDiagnosticValue(responseBody)}`);

  console.error(`[smoke] current stage=${currentStage}`);
  console.error(`[smoke] last observed event=${lastObservedEvent ?? 'none'}`);
  console.error(`[smoke] elapsedMs=${elapsedMs}`);
  if (tempSessionDirectory !== undefined)
    console.error(`[smoke] temp session directory=${tempSessionDirectory}`);
  if (sessionStore !== undefined && knownSessionId !== undefined) {
    try {
      logSessionManagerSummary(sessionStore.load(knownSessionId), (message) =>
        console.error(message),
      );
    } catch (reloadError: unknown) {
      console.error(`[smoke] session reload error=${formatDiagnosticValue(reloadError)}`);
    }
  }
}

/** Runs two real filesystem-backed conversation turns through the Application boundary. */
async function main(): Promise<void> {
  const startedAt = Date.now();
  let tempSessionDirectory: string | undefined;
  let sessionStore: FileSystemSessionStore | undefined;
  let knownSessionId: string | undefined;
  let currentStage = 'startup';
  let lastObservedEvent: string | undefined;
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];

  try {
    loadLocalEnvironment();
    if (!process.env[API_KEY_ENV]?.trim()) throw new Error('MOONSHOT_API_KEY is not configured.');

    currentStage = 'loading config';
    console.info('[smoke] loading config');
    const config = await loadModelGatewayConfig(modelConfigPath);
    const gateway = createModelGateway(config);
    const model = gateway.getModel(PROVIDER_ID, MODEL_ID);
    if (!model) throw new Error('moonshot/kimi-k3 is not configured.');

    console.info(`[smoke] provider=${PROVIDER_ID}`);
    console.info(`[smoke] model=${MODEL_ID}`);

    currentStage = 'creating temp session directory';
    tempSessionDirectory = await mkdtemp(join(tmpdir(), 'opspilot-conversation-kimi-'));
    console.info('[smoke] creating temp session directory');
    console.info(`[smoke] temp session directory=${tempSessionDirectory}`);

    currentStage = 'creating FileSystemSessionStore';
    sessionStore = new FileSystemSessionStore(tempSessionDirectory);
    console.info('[smoke] creating FileSystemSessionStore');

    currentStage = 'creating RunConversationTurn';
    const runConversationTurn = new RunConversationTurn({
      sessionStore,
      modelGateway: gateway,
      defaultModel: model,
      toolDefinitions: [],
    });
    console.info('[smoke] creating RunConversationTurn');

    const firstPrompt = 'Reply with OK only.';
    currentStage = 'starting first turn';
    console.info('[smoke] starting first turn');
    const firstStartedAt = Date.now();
    const firstResult = await executeWithWatchdog(
      runConversationTurn.execute(
        { message: createUserMessage(firstPrompt) },
        {
          onEvent: (event) =>
            recordApplicationEvent('first', event, firstEvents, (value) => {
              lastObservedEvent = value;
            }),
        },
      ),
      'first',
      () => {
        logWatchdogDiagnostics(
          tempSessionDirectory!,
          sessionStore!,
          knownSessionId,
          'first',
          currentStage,
          lastObservedEvent,
          Date.now() - firstStartedAt,
        );
        process.exitCode = 1;
      },
    );
    knownSessionId = firstResult.sessionId;
    currentStage = 'first turn resolved';
    console.info('[smoke] first turn resolved');
    console.info(`[smoke] first elapsedMs=${Date.now() - firstStartedAt}`);
    logTurnResult('first', firstResult, firstPrompt);

    if (!firstResult.sessionId) throw new Error('First turn did not produce a sessionId.');
    if (firstResult.leafId === null) throw new Error('First turn did not produce a leafId.');
    const firstAssistant = requireSuccessfulAssistant(firstResult, 'first');

    currentStage = 'reloading persisted session';
    console.info('[smoke] reloading persisted session');
    const sessionFilePath = join(tempSessionDirectory, `${firstResult.sessionId}.jsonl`);
    if (!existsSync(sessionFilePath))
      throw new Error(`Expected persisted Session file was not created: ${sessionFilePath}`);
    const firstPersisted = sessionStore.load(firstResult.sessionId);
    logSessionManagerSummary(firstPersisted, (message) => console.info(message));
    const firstEntries = firstPersisted.getEntries();
    if (!firstEntries.some((entry) => entry.type === 'model_change'))
      throw new Error('Persisted Session is missing model_change.');
    if (!firstEntries.some((entry) => entry.type === 'thinking_level_change'))
      throw new Error('Persisted Session is missing thinking_level_change.');
    if (firstEntries.filter((entry) => entry.type === 'message').length < 2)
      throw new Error('Persisted Session is missing the first user/assistant messages.');
    if (firstPersisted.getLeafId() === null)
      throw new Error('Reloaded first Session did not have a leafId.');
    const firstContext = firstPersisted.buildSessionContext();
    console.info(`[smoke] first reloaded context.messages.length=${firstContext.messages.length}`);
    console.info(
      `[smoke] first reloaded context.model=${formatDiagnosticValue(firstContext.model)}`,
    );

    const secondPrompt = 'What did I ask you to do in my previous message? Answer briefly.';
    currentStage = 'starting second turn';
    console.info('[smoke] starting second turn');
    const secondStartedAt = Date.now();
    const secondResult = await executeWithWatchdog(
      runConversationTurn.execute(
        { sessionId: firstResult.sessionId, message: createUserMessage(secondPrompt) },
        {
          onEvent: (event) =>
            recordApplicationEvent('second', event, secondEvents, (value) => {
              lastObservedEvent = value;
            }),
        },
      ),
      'second',
      () => {
        logWatchdogDiagnostics(
          tempSessionDirectory!,
          sessionStore!,
          knownSessionId,
          'second',
          currentStage,
          lastObservedEvent,
          Date.now() - secondStartedAt,
        );
        process.exitCode = 1;
      },
    );
    currentStage = 'second turn resolved';
    console.info('[smoke] second turn resolved');
    console.info(`[smoke] second elapsedMs=${Date.now() - secondStartedAt}`);
    logTurnResult('second', secondResult, secondPrompt);

    if (secondResult.sessionId !== firstResult.sessionId)
      throw new Error('Second turn created or returned a different sessionId.');
    if (secondResult.leafId === null) throw new Error('Second turn did not produce a leafId.');
    const secondAssistant = requireSuccessfulAssistant(secondResult, 'second');

    const finalPersisted = sessionStore.load(firstResult.sessionId);
    const finalEntries = finalPersisted.getEntries();
    if (finalEntries.length <= firstEntries.length)
      throw new Error('Second turn did not append entries to the existing Session.');
    logAndValidateFinalContext(finalPersisted, firstPrompt, secondPrompt);

    console.info(`[smoke] first events=${firstEvents.join(' -> ')}`);
    console.info(`[smoke] second events=${secondEvents.join(' -> ')}`);
    console.info('[smoke] first turn: success');
    console.info('[smoke] second turn: success');
    console.info('[smoke] persisted session reload: success');
    console.info('[smoke] same session id: true');
    console.info(
      `[smoke] final context message count=${finalPersisted.buildSessionContext().messages.length}`,
    );
    console.info(`[smoke] first assistant finishReason=${firstAssistant.finishReason}`);
    console.info(`[smoke] second assistant finishReason=${secondAssistant.finishReason}`);
    console.info(`[smoke] total elapsedMs=${Date.now() - startedAt}`);
  } catch (error: unknown) {
    logFailure(
      error,
      currentStage,
      lastObservedEvent,
      tempSessionDirectory,
      sessionStore,
      knownSessionId,
      Date.now() - startedAt,
    );
    process.exitCode = 1;
  } finally {
    if (tempSessionDirectory !== undefined)
      await rm(tempSessionDirectory, { recursive: true, force: true });
  }
}

/** Creates the minimal user message expected by RunConversationTurn. */
function createUserMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** Prints one turn result and its last assistant text. */
function logTurnResult(turn: TurnLabel, result: RunConversationTurnResult, prompt: string): void {
  const assistant = findLastAssistant(result.messages);
  console.info(`[smoke] ${turn} sessionId=${result.sessionId}`);
  console.info(`[smoke] ${turn} leafId=${result.leafId ?? 'none'}`);
  console.info(`[smoke] ${turn} messages.length=${result.messages.length}`);
  console.info(`[smoke] ${turn} prompt=${prompt}`);
  console.info(`[smoke] ${turn} last assistant finishReason=${assistant?.finishReason ?? 'none'}`);
  console.info(
    `[smoke] ${turn} last assistant errorMessage=${formatDiagnosticValue(assistant?.errorMessage)}`,
  );
  console.info(
    `[smoke] ${turn} assistant text=${assistant ? redactSensitiveText(extractText(assistant)) : 'none'}`,
  );
}

/** Requires a non-error assistant result before the next filesystem turn proceeds. */
function requireSuccessfulAssistant(
  result: RunConversationTurnResult,
  turn: TurnLabel,
): AssistantMessage {
  const assistant = findLastAssistant(result.messages);
  if (!assistant) throw new Error(`${turn} turn returned no assistant message.`);
  if (assistant.finishReason === 'error' || assistant.finishReason === 'aborted')
    throw new Error(
      `${turn} turn assistant failed: ${assistant.errorMessage ?? assistant.finishReason}.`,
    );
  return assistant;
}

await main();
