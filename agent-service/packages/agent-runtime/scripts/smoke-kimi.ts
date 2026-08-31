import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createModelGateway,
  loadModelGatewayConfig,
  type AssistantMessage,
} from '@opspilot/model-gateway';

import { Agent, type AgentEvent, type AgentMessage } from '../src/index.js';

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

/** Prints the current Agent state using only short, diagnostic-safe fields. */
function logAgentState(agent: Agent, write: DiagnosticWriter, prefix = 'state'): void {
  const state = agent.state;
  write(`[smoke] ${prefix}.isRunning=${state.isRunning}`);
  write(`[smoke] ${prefix}.messages.length=${state.messages.length}`);
  write(`[smoke] ${prefix}.streamingMessage=${summarizeMessage(state.streamingMessage)}`);
  write(`[smoke] ${prefix}.pendingToolCalls=${state.pendingToolCalls.length}`);
  write(`[smoke] ${prefix}.errorMessage=${formatDiagnosticValue(state.errorMessage)}`);
  write(`[smoke] ${prefix}.errorInfo=${formatDiagnosticValue(state.errorInfo)}`);
}

/** Records each AgentEvent type and summarizes message events for lifecycle diagnosis. */
function logAgentEvent(event: AgentEvent): void {
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
  console.info(`[agent-event] ${event.type}`);
}

/** Prints enough error metadata to distinguish Runtime, provider, and transport failures. */
function logFailure(
  error: unknown,
  agent: Agent | undefined,
  lastObservedEventType: AgentEvent['type'] | undefined,
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

  console.error(`[smoke] last observed AgentEvent type=${lastObservedEventType ?? 'none'}`);
  if (agent) logAgentState(agent, (message) => console.error(message));
}

/** Extracts only user-visible text content from the final assistant message. */
function extractText(message: AssistantMessage): string {
  return message.content.map((content) => (content.type === 'text' ? content.text : '')).join('');
}

/** Narrows a Runtime message to the normalized assistant message contract. */
function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

/** Runs Agent.prompt() with a script-only watchdog and aborts the active run on timeout. */
async function promptWithWatchdog(
  agent: Agent,
  prompt: AgentMessage,
  onTimeout: () => void,
): Promise<readonly AgentMessage[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      agent.abort();
      reject(new Error(`agent.prompt() did not resolve within ${WATCHDOG_TIMEOUT_MS}ms`));
    }, WATCHDOG_TIMEOUT_MS);
  });

  try {
    return await Promise.race([agent.prompt(prompt), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Creates one real Agent and runs the smallest possible prompt through Moonshot. */
async function main(): Promise<void> {
  const startedAt = Date.now();
  let agent: Agent | undefined;
  let lastObservedEventType: AgentEvent['type'] | undefined;
  let unsubscribe: (() => void) | undefined;

  try {
    loadLocalEnvironment();
    if (!process.env[API_KEY_ENV]?.trim()) throw new Error('MOONSHOT_API_KEY is not configured.');

    const config = await loadModelGatewayConfig(modelConfigPath);
    const gateway = createModelGateway(config);
    const model = gateway.getModel(PROVIDER_ID, MODEL_ID);
    if (!model) throw new Error('moonshot/kimi-k3 is not configured.');

    console.info(`[smoke] provider=${PROVIDER_ID}`);
    console.info(`[smoke] model=${MODEL_ID}`);
    console.info('[smoke] creating agent');
    agent = new Agent({
      model,
      streamFn: (streamModel, context, options) => gateway.stream(streamModel, context, options),
    });
    unsubscribe = agent.subscribe((event) => {
      lastObservedEventType = event.type;
      logAgentEvent(event);
    });

    const prompt: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'Reply with OK only.' }],
    };

    console.info('[smoke] starting agent.prompt()');
    const messages = await promptWithWatchdog(agent, prompt, () => {
      console.error(`[smoke] agent.prompt() did not resolve within ${WATCHDOG_TIMEOUT_MS}ms`);
      console.error(`[smoke] last observed AgentEvent type=${lastObservedEventType ?? 'none'}`);
      logAgentState(agent!, (message) => console.error(message), 'agent.state');
      process.exitCode = 1;
    });
    console.info('[smoke] agent.prompt() resolved');

    const lastAssistant = [...messages].reverse().find(isAssistantMessage);
    if (!lastAssistant) throw new Error('Agent prompt resolved without an assistant message.');

    console.info(`[smoke] message count=${messages.length}`);
    console.info(`[smoke] last message role=${messages.at(-1)?.role ?? 'none'}`);
    console.info(`[smoke] last assistant finishReason=${lastAssistant.finishReason}`);
    console.info(
      `[smoke] last assistant errorMessage=${formatDiagnosticValue(lastAssistant.errorMessage)}`,
    );
    console.info(`[smoke] assistant text=${redactSensitiveText(extractText(lastAssistant))}`);
    logAgentState(agent, (message) => console.info(message));

    if (
      lastAssistant.finishReason === 'error' ||
      lastAssistant.finishReason === 'aborted' ||
      agent.state.errorMessage !== undefined
    ) {
      process.exitCode = 1;
    }
  } catch (error: unknown) {
    logFailure(error, agent, lastObservedEventType);
    process.exitCode = 1;
  } finally {
    unsubscribe?.();
    console.info(`[smoke] elapsedMs=${Date.now() - startedAt}`);
  }
}

await main();
