import { describe, expect, it, vi } from 'vitest';

import {
  createModelEventStream,
  createRetryingModelEventStream,
  type AssistantMessage,
  type Model,
  type ModelErrorInfo,
  type ModelEventStream,
  type ModelStreamEvent,
} from '../src/index.js';

const model: Model = {
  id: 'kimi',
  name: 'Kimi',
  provider: 'moonshot',
  api: 'openai-completions',
  baseUrl: 'https://moonshot.example/v1',
  reasoning: false,
};

const pending: AssistantMessage = {
  role: 'assistant',
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [],
  finishReason: 'pending',
};

describe('Model Gateway retry coordinator', () => {
  it('retries a rate limit failure and exposes only one logical stream', async () => {
    const sleep = vi.fn(async () => undefined);
    const onAttempt = vi.fn();
    const stream = scriptedRetryStream(
      [failed('rate_limit'), succeeded('ok')],
      [],
      { sleep, random: () => 0.5 },
      onAttempt,
    );

    const events = await collect(stream);

    expect(events.map((event) => event.type)).toEqual(['start', 'retry', 'done']);
    expect(events[1]).toMatchObject({
      type: 'retry',
      failedAttempt: 1,
      nextAttempt: 2,
      delayMs: 500,
      error: { kind: 'rate_limit' },
    });
    expect(sleep).toHaveBeenCalledWith(500, undefined);
    expect(onAttempt).toHaveBeenCalledTimes(2);
    await expect(stream.result()).resolves.toMatchObject({ finishReason: 'stop' });
  });

  it('uses bounded exponential backoff across timeout and server failures', async () => {
    const delays: number[] = [];
    const onAttempt = vi.fn();
    const stream = scriptedRetryStream(
      [failed('timeout'), failed('server_error'), succeeded('ok')],
      [],
      {
        policy: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 750, jitterRatio: 0 },
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      },
      onAttempt,
    );

    const events = await collect(stream);

    expect(events.filter((event) => event.type === 'retry')).toMatchObject([
      { failedAttempt: 1, nextAttempt: 2, delayMs: 500, error: { kind: 'timeout' } },
      { failedAttempt: 2, nextAttempt: 3, delayMs: 750, error: { kind: 'server_error' } },
    ]);
    expect(delays).toEqual([500, 750]);
    expect(onAttempt).toHaveBeenCalledTimes(3);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('returns only the final failure after retry quota exhaustion', async () => {
    const stream = scriptedRetryStream(
      [failed('network'), failed('network'), failed('network')],
      [],
      { sleep: async () => undefined, random: () => 0.5 },
    );

    const events = await collect(stream);

    expect(events.map((event) => event.type)).toEqual(['start', 'retry', 'retry', 'error']);
    await expect(stream.result()).resolves.toMatchObject({
      finishReason: 'error',
      modelError: { kind: 'network', retryable: true },
    });
  });

  it.each(['authentication', 'invalid_request', 'protocol_error', 'context_overflow'] as const)(
    'does not retry non-retryable %s failures',
    async (kind) => {
      const stream = scriptedRetryStream([failed(kind)]);

      const events = await collect(stream);

      expect(events.map((event) => event.type)).toEqual(['start', 'error']);
    },
  );

  it('stops before the next provider attempt when aborted during backoff', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const stream = createRetryingModelEventStream(
      () => {
        attempts += 1;
        return attempt(failed('timeout'));
      },
      controller.signal,
      {
        random: () => 0.5,
        sleep: async () => {
          controller.abort();
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        },
      },
    );

    const events = await collect(stream);

    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual(['start', 'retry', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
    await expect(stream.result()).resolves.toMatchObject({
      finishReason: 'aborted',
      errorMessage: 'Request aborted.',
    });
    expect(await stream.result()).not.toHaveProperty('modelError');
  });

  it.each([
    {
      label: 'text delta',
      event: { type: 'text.delta', contentIndex: 0, delta: 'x', partial: pending } as const,
    },
    {
      label: 'thinking delta',
      event: { type: 'thinking.delta', contentIndex: 0, delta: 'x', partial: pending } as const,
    },
    {
      label: 'tool-call delta',
      event: {
        type: 'tool-call.delta',
        contentIndex: 0,
        callId: 'call-1',
        delta: '{',
        partial: pending,
      } as const,
    },
    {
      label: 'completed tool call',
      event: {
        type: 'tool-call.completed',
        contentIndex: 0,
        toolCall: { callId: 'call-1', name: 'lookup', arguments: {} },
        partial: pending,
      } as const,
    },
  ])('does not retry after meaningful $label output', async ({ event }) => {
    const stream = scriptedRetryStream([failed('timeout')], [[event]]);

    const events = await collect(stream);

    expect(events.map((item) => item.type)).toEqual(['start', event.type, 'error']);
  });

  it('allows retry after start and usage-only output without leaking failed-attempt usage', async () => {
    const failedUsage = { inputTokens: 10, outputTokens: 0, totalTokens: 10 };
    const stream = scriptedRetryStream(
      [failed('timeout'), succeeded('ok')],
      [[{ type: 'usage', usage: failedUsage, partial: { ...pending, usage: failedUsage } }], []],
      { sleep: async () => undefined, random: () => 0.5 },
    );

    const events = await collect(stream);

    expect(events.map((event) => event.type)).toEqual(['start', 'retry', 'done']);
  });
});

function scriptedRetryStream(
  responses: readonly AssistantMessage[],
  attemptEvents: readonly (readonly ModelStreamEvent[])[] = [],
  options: Parameters<typeof createRetryingModelEventStream>[2] = {
    sleep: async () => undefined,
    random: () => 0.5,
  },
  onAttempt: () => void = () => undefined,
): ModelEventStream {
  let index = 0;
  return createRetryingModelEventStream(() => {
    onAttempt();
    const response = responses[index];
    if (response === undefined) throw new Error('Unexpected provider attempt.');
    const events = attemptEvents[index] ?? [];
    index += 1;
    return attempt(response, events);
  }, undefined, options);
}

function attempt(
  response: AssistantMessage,
  events: readonly ModelStreamEvent[] = [],
): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({ type: 'start', model, partial: pending });
    for (const event of events) controller.emit(event);
    if (response.finishReason === 'error' || response.finishReason === 'aborted') {
      controller.error(response);
    } else {
      controller.complete(response);
    }
  });
}

function failed(kind: ModelErrorInfo['kind']): AssistantMessage {
  const retryable =
    kind === 'rate_limit' || kind === 'timeout' || kind === 'network' || kind === 'server_error';
  return {
    ...pending,
    finishReason: 'error',
    errorMessage: `failed: ${kind}`,
    modelError: {
      kind,
      code: codeFor(kind),
      message: `failed: ${kind}`,
      retryable,
    },
  };
}

function succeeded(text: string): AssistantMessage {
  return {
    ...pending,
    content: [{ type: 'text', text }],
    finishReason: 'stop',
  };
}

function codeFor(kind: ModelErrorInfo['kind']): ModelErrorInfo['code'] {
  const codes: Record<ModelErrorInfo['kind'], ModelErrorInfo['code']> = {
    authentication: 'MODEL_AUTHENTICATION',
    invalid_request: 'MODEL_INVALID_REQUEST',
    rate_limit: 'MODEL_RATE_LIMIT',
    timeout: 'MODEL_TIMEOUT',
    network: 'MODEL_NETWORK',
    server_error: 'MODEL_SERVER_ERROR',
    protocol_error: 'MODEL_PROTOCOL_ERROR',
    context_overflow: 'MODEL_CONTEXT_OVERFLOW',
    unknown: 'MODEL_UNKNOWN',
  };
  return codes[kind];
}

async function collect(stream: ModelEventStream): Promise<ModelStreamEvent[]> {
  const events: ModelStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
