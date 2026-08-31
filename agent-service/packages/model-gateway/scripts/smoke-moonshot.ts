import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  createModelGateway,
  loadModelGatewayConfig,
  type AssistantMessage,
  type Context,
} from '../src/index.js';

const PROVIDER_ID = 'moonshot';
const MODEL_ID = 'kimi-k3';
const API_KEY_ENV = 'MOONSHOT_API_KEY';
const envFilePath = fileURLToPath(new URL('../../../.env', import.meta.url));
const modelConfigPath = fileURLToPath(
  new URL('../../../config/model-providers.json', import.meta.url),
);

type ErrorRecord = Record<string, unknown>;

/** Loads the agent-service-local environment file when it is available. */
function loadLocalEnvironment(): void {
  if (existsSync(envFilePath)) loadEnvFile(envFilePath);
}

/** Returns an object-like view of an unknown error value. */
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

/** Converts an error field to one-line, secret-safe diagnostic text. */
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

/** Prints enough structured information to distinguish provider and transport failures. */
function logFailure(error: unknown): void {
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
}

/** Extracts only user-visible text content from the normalized assistant response. */
function extractText(response: AssistantMessage): string {
  return response.content.map((content) => (content.type === 'text' ? content.text : '')).join('');
}

/** Runs one minimal, non-streaming request through the configured ModelGateway. */
async function main(): Promise<void> {
  let requestStartedAt: number | undefined;

  try {
    loadLocalEnvironment();
    if (!process.env[API_KEY_ENV]?.trim()) throw new Error('MOONSHOT_API_KEY is not configured.');

    const config = await loadModelGatewayConfig(modelConfigPath);
    const gateway = createModelGateway(config);
    const model = gateway.getModel(PROVIDER_ID, MODEL_ID);
    if (!model) throw new Error('moonshot/kimi-k3 is not configured.');

    console.info(`[smoke] provider=${PROVIDER_ID}`);
    console.info(`[smoke] model=${MODEL_ID}`);
    console.info(`[smoke] api=${model.api}`);
    console.info(`[smoke] baseUrl=${model.baseUrl}`);

    const context: Context = {
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: '你好，请简单介绍一下你自己。' }],
        },
      ],
    };

    requestStartedAt = Date.now();
    console.info('[smoke] starting request...');
    const response = await gateway.complete(model, context);

    console.info('[smoke] request completed');
    console.info(`[smoke] finishReason=${response.finishReason}`);
    console.info(`[smoke] provider=${response.provider}`);
    console.info(`[smoke] model=${response.model}`);
    console.info(`[smoke] usage=${formatDiagnosticValue(response.usage ?? null)}`);
    console.info(`[smoke] text=${redactSensitiveText(extractText(response))}`);
  } catch (error: unknown) {
    logFailure(error);
    process.exitCode = 1;
  } finally {
    if (requestStartedAt !== undefined)
      console.info(`[smoke] elapsedMs=${Date.now() - requestStartedAt}`);
  }
}

await main();
