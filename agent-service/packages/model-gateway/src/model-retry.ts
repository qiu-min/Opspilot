import {
  createModelEventStream,
  type AssistantMessage,
  type ModelErrorInfo,
  type ModelEventStream,
  type ModelStreamEvent,
  type StreamController,
} from './contracts/index.js';

/** Retry limits owned by the Model Gateway for one logical model call. */
export interface ModelRetryPolicy {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly jitterRatio: number;
}

export type ModelRetrySleep = (delayMs: number, signal?: AbortSignal) => Promise<void>;
export type ModelRetryRandom = () => number;

/** Injectable policy and timing dependencies used by the retry coordinator. */
export interface ModelRetryOptions {
  readonly policy?: ModelRetryPolicy;
  readonly sleep?: ModelRetrySleep;
  readonly random?: ModelRetryRandom;
}

export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 5_000,
  jitterRatio: 0.2,
});

/**
 * Coordinates transparent provider retries while preserving one public model stream.
 * Intermediate terminal failures and usage are suppressed from callers.
 */
export function createRetryingModelEventStream(
  createAttempt: () => ModelEventStream,
  signal?: AbortSignal,
  options: ModelRetryOptions = {},
): ModelEventStream {
  const policy = options.policy ?? DEFAULT_MODEL_RETRY_POLICY;
  validatePolicy(policy);
  const sleep = options.sleep ?? abortableSleep;
  const random = options.random ?? Math.random;

  return createModelEventStream(async (controller) => {
    let attemptNumber = 1;
    let startEmitted = false;

    while (true) {
      const attempt = createAttempt();
      const bufferedUsage: Extract<ModelStreamEvent, { type: 'usage' }>[] = [];
      let meaningfulOutput = false;
      let terminal: AssistantMessage | undefined;

      for await (const event of attempt) {
        switch (event.type) {
          case 'start':
            if (!startEmitted) {
              startEmitted = true;
              controller.emit(event);
            }
            break;
          case 'usage':
            bufferedUsage.push(event);
            break;
          case 'text.delta':
          case 'thinking.delta':
          case 'tool-call.delta':
          case 'tool-call.completed':
            if (!meaningfulOutput) flushUsage(controller, bufferedUsage);
            meaningfulOutput = true;
            controller.emit(event);
            break;
          case 'retry':
            throw new Error('Model adapters must not emit retry events.');
          case 'done':
            terminal = event.response;
            break;
          case 'error':
            terminal = event.error;
            break;
        }
      }

      terminal ??= await attempt.result();
      if (signal?.aborted && terminal.finishReason === 'error') {
        flushUsage(controller, bufferedUsage);
        controller.error(toAbortedMessage(terminal));
        return;
      }
      if (shouldRetry(terminal, meaningfulOutput, attemptNumber, policy, signal)) {
        const failedAttempt = attemptNumber;
        const nextAttempt = failedAttempt + 1;
        const delayMs = calculateRetryDelay(policy, failedAttempt, random);
        controller.emit({
          type: 'retry',
          failedAttempt,
          nextAttempt,
          delayMs,
          error: terminal.modelError,
        });

        try {
          await sleep(delayMs, signal);
        } catch (error: unknown) {
          if (!signal?.aborted) throw error;
          controller.error(toAbortedMessage(terminal));
          return;
        }
        if (signal?.aborted) {
          controller.error(toAbortedMessage(terminal));
          return;
        }
        attemptNumber = nextAttempt;
        continue;
      }

      flushUsage(controller, bufferedUsage);
      if (terminal.finishReason === 'error' || terminal.finishReason === 'aborted') {
        controller.error(terminal);
      } else {
        controller.complete(terminal);
      }
      return;
    }
  });
}

function shouldRetry(
  response: AssistantMessage,
  meaningfulOutput: boolean,
  failedAttempt: number,
  policy: ModelRetryPolicy,
  signal: AbortSignal | undefined,
): response is AssistantMessage & {
  readonly finishReason: 'error';
  readonly modelError: ModelErrorInfo;
} {
  return (
    response.finishReason === 'error' &&
    response.modelError?.retryable === true &&
    !meaningfulOutput &&
    failedAttempt <= policy.maxRetries &&
    signal?.aborted !== true
  );
}

function flushUsage(
  controller: StreamController,
  bufferedUsage: Extract<ModelStreamEvent, { type: 'usage' }>[],
): void {
  for (const event of bufferedUsage.splice(0)) controller.emit(event);
}

function calculateRetryDelay(
  policy: ModelRetryPolicy,
  failedAttempt: number,
  random: ModelRetryRandom,
): number {
  const exponentialDelay = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (failedAttempt - 1),
  );
  const randomValue = random();
  if (!Number.isFinite(randomValue)) throw new Error('Model retry random sample must be finite.');
  const sample = Math.min(1, Math.max(0, randomValue));
  const jitterMultiplier = 1 + (sample * 2 - 1) * policy.jitterRatio;
  return Math.min(policy.maxDelayMs, Math.max(0, Math.round(exponentialDelay * jitterMultiplier)));
}

/** Waits for the requested delay and rejects immediately when the caller aborts. */
async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw createAbortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createAbortError(): Error {
  const error = new Error('Request aborted.');
  error.name = 'AbortError';
  return error;
}

function toAbortedMessage(response: AssistantMessage): AssistantMessage {
  const aborted: AssistantMessage & { modelError?: ModelErrorInfo } = {
    ...response,
    finishReason: 'aborted',
    errorMessage: 'Request aborted.',
  };
  delete aborted.modelError;
  return aborted;
}

function validatePolicy(policy: ModelRetryPolicy): void {
  if (!Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0) {
    throw new Error('Model retry maxRetries must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(policy.baseDelayMs) || policy.baseDelayMs < 0) {
    throw new Error('Model retry baseDelayMs must be a non-negative integer.');
  }
  if (!Number.isSafeInteger(policy.maxDelayMs) || policy.maxDelayMs < policy.baseDelayMs) {
    throw new Error('Model retry maxDelayMs must be an integer no smaller than baseDelayMs.');
  }
  if (
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new Error('Model retry jitterRatio must be between 0 and 1.');
  }
}
