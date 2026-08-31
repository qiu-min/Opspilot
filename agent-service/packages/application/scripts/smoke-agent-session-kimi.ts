import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import type { AgentMessage } from '@opspilot/agent-runtime';
import {
  createModelGateway,
  loadModelGatewayConfig,
  type AssistantMessage,
} from '@opspilot/model-gateway';

import {
  AgentSession,
  createAgentSession,
  SessionManager,
  type AgentSessionEvent,
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

/** Prints the current AgentSession state using only short diagnostic-safe fields. */
function logAgentSessionState(
  agentSession: AgentSession,
  write: DiagnosticWriter,
  prefix = 'state',
): void {
  const state = agentSession.state;
  write(`[smoke] ${prefix}.isRunning=${state.isRunning}`);
  write(`[smoke] ${prefix}.messages.length=${state.messages.length}`);
  write(`[smoke] ${prefix}.pendingToolCalls=${state.pendingToolCalls.length}`);
  write(`[smoke] ${prefix}.errorMessage=${formatDiagnosticValue(state.errorMessage)}`);
  write(`[smoke] ${prefix}.errorInfo=${formatDiagnosticValue(state.errorInfo)}`);
}

/** Prints SessionManager facts without dumping the complete session log. */
function logSessionManagerSummary(sessionManager: SessionManager, write: DiagnosticWriter): void {
  const entries = sessionManager.getEntries();
  const branchEntries = sessionManager.getBranch();
  write(`[smoke] sessionId=${sessionManager.getHeader().id}`);
  write(`[smoke] leafId=${sessionManager.getLeafId() ?? 'none'}`);
  write(`[smoke] entry count=${entries.length}`);
  write(`[smoke] branch entry count=${branchEntries.length}`);
  write(`[smoke] entry types=${entries.map((entry) => entry.type).join(' -> ') || 'none'}`);
}

/** Records each AgentSessionEvent type and summarizes high-frequency message events. */
function logAgentSessionEvent(event: AgentSessionEvent): void {
  if (
    event.type === 'message_start' ||
    event.type === 'message_update' ||
    event.type === 'message_end'
  ) {
    console.info(`[agent-event] ${event.type} ${summarizeMessage(event.message)}`);
    return;
  }
  if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
    console.info(`[agent-event] ${event.type} tool=${event.toolCall.name}`);
    return;
  }
  if (event.type === 'compaction_start' || event.type === 'compaction_end') {
    console.info(`[agent-event] ${event.type} reason=${event.reason}`);
    return;
  }
  console.info(`[agent-event] ${event.type}`);
}

/** Prints provider/runtime error metadata and the latest Application state. */
function logFailure(
  error: unknown,
  agentSession: AgentSession | undefined,
  sessionManager: SessionManager | undefined,
  lastObservedEventType: AgentSessionEvent['type'] | undefined,
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

  console.error(`[smoke] last observed AgentSessionEvent=${lastObservedEventType ?? 'none'}`);
  if (agentSession) logAgentSessionState(agentSession, (message) => console.error(message));
  if (sessionManager) logSessionManagerSummary(sessionManager, (message) => console.error(message));
}

/** Extracts only user-visible text content from the final assistant message. */
function extractText(message: AssistantMessage): string {
  return message.content.map((content) => (content.type === 'text' ? content.text : '')).join('');
}

/** Narrows a Runtime message to the normalized assistant message contract. */
function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

/** Runs AgentSession.prompt() with a script-only watchdog and aborts active work on timeout. */
async function promptWithWatchdog(
  agentSession: AgentSession,
  prompt: AgentMessage,
  onTimeout: () => void,
): Promise<readonly AgentMessage[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      agentSession.abort();
      agentSession.abortCompaction();
      reject(new Error(`AgentSession.prompt() did not resolve within ${WATCHDOG_TIMEOUT_MS}ms`));
    }, WATCHDOG_TIMEOUT_MS);
  });

  try {
    return await Promise.race([agentSession.prompt(prompt), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Creates an in-memory AgentSession and runs the smallest possible prompt through Kimi. */
async function main(): Promise<void> {
  const startedAt = Date.now();
  let elapsedLogged = false;
  let agentSession: AgentSession | undefined;
  let sessionManager: SessionManager | undefined;
  let lastObservedEventType: AgentSessionEvent['type'] | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    loadLocalEnvironment();
    if (!process.env[API_KEY_ENV]?.trim()) throw new Error('MOONSHOT_API_KEY is not configured.');

    console.info('[smoke] loading config');
    const config = await loadModelGatewayConfig(modelConfigPath);
    const gateway = createModelGateway(config);
    const model = gateway.getModel(PROVIDER_ID, MODEL_ID);
    if (!model) throw new Error('moonshot/kimi-k3 is not configured.');

    console.info(`[smoke] provider=${PROVIDER_ID}`);
    console.info(`[smoke] model=${MODEL_ID}`);
    console.info('[smoke] creating in-memory session');
    sessionManager = SessionManager.inMemory();
    console.info('[smoke] creating AgentSession');
    agentSession = createAgentSession({
      sessionManager,
      modelGateway: gateway,
      model,
    });
    unsubscribe = agentSession.subscribe((event) => {
      lastObservedEventType = event.type;
      logAgentSessionEvent(event);
    });

    const userMessage: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Reply with OK only.' }],
    };

    console.info('[smoke] starting AgentSession.prompt()');
    const messages = await promptWithWatchdog(agentSession, userMessage, () => {
      console.error(
        `[smoke] AgentSession.prompt() did not resolve within ${WATCHDOG_TIMEOUT_MS}ms`,
      );
      console.error(`[smoke] last observed AgentSessionEvent=${lastObservedEventType ?? 'none'}`);
      logAgentSessionState(
        agentSession!,
        (message) => console.error(message),
        'agentSession.state',
      );
      logSessionManagerSummary(sessionManager!, (message) => console.error(message));
      process.exitCode = 1;
    });
    elapsedLogged = true;
    console.info('[smoke] AgentSession.prompt() resolved');
    console.info(`[smoke] elapsedMs=${Date.now() - startedAt}`);

    const lastAssistant = [...messages].reverse().find(isAssistantMessage);
    if (!lastAssistant)
      throw new Error('AgentSession prompt resolved without an assistant message.');

    console.info(`[smoke] returned message count=${messages.length}`);
    console.info(`[smoke] last assistant finishReason=${lastAssistant.finishReason}`);
    console.info(
      `[smoke] last assistant errorMessage=${formatDiagnosticValue(lastAssistant.errorMessage)}`,
    );
    console.info(`[smoke] assistant text=${redactSensitiveText(extractText(lastAssistant))}`);

    logSessionManagerSummary(sessionManager, (message) => console.info(message));
    const context = sessionManager.buildSessionContext();
    console.info(`[smoke] context.messages.length=${context.messages.length}`);
    console.info(`[smoke] context.model=${formatDiagnosticValue(context.model)}`);
    console.info(`[smoke] context.thinkingLevel=${context.thinkingLevel}`);
    console.info(
      `[smoke] context.hasUserMessage=${context.messages.some((message) => message.role === 'user')}`,
    );
    console.info(
      `[smoke] context.hasAssistantMessage=${context.messages.some((message) => message.role === 'assistant')}`,
    );

    logAgentSessionState(agentSession, (message) => console.info(message));
    if (
      lastAssistant.finishReason === 'error' ||
      lastAssistant.finishReason === 'aborted' ||
      agentSession.state.errorMessage !== undefined
    ) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    logFailure(error, agentSession, sessionManager, lastObservedEventType);
    process.exitCode = 1;
  } finally {
    unsubscribe?.();
    if (agentSession) {
      try {
        await agentSession.waitForIdle();
      } finally {
        agentSession.dispose();
      }
    }
    if (!elapsedLogged) console.info(`[smoke] elapsedMs=${Date.now() - startedAt}`);
  }
}

await main();
