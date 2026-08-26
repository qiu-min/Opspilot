import { describe, expect, it } from 'vitest';
import {
  contextSchema,
  createModelEventStream,
  finishReasonSchema,
  messageSchema,
  modelSchema,
  optionsSchema,
  validateContext,
  validateModelToolCall,
  validateOptions,
} from '../src/index.js';

const model = {
  provider: 'openai',
  id: 'gpt-test',
  name: 'GPT Test',
  api: 'openai-completions',
  baseUrl: 'https://api.example.test/v1',
  supportsTools: true,
  reasoning: false,
};
const context = {
  systemPrompt: 'You are a concise operations assistant.',
  messages: [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Investigate the alert.' }] },
  ],
  tools: [
    {
      name: 'query_logs',
      description: 'Read service logs.',
      parameters: { type: 'object', properties: { service: { type: 'string' } } },
    },
  ],
};

describe('model gateway contracts', () => {
  it('accepts pending only for an in-flight assistant message', () => {
    expect(finishReasonSchema.safeParse('pending').success).toBe(true);
    expect(finishReasonSchema.safeParse('error').success).toBe(true);
    expect(finishReasonSchema.safeParse('aborted').success).toBe(true);
  });

  it('validates Model, Context, and Options independently', () => {
    expect(modelSchema.safeParse(model).success).toBe(true);
    expect(contextSchema.safeParse(context).success).toBe(true);
    expect(optionsSchema.safeParse({ temperature: 0.2, maxTokens: 500 }).success).toBe(true);
    expect(modelSchema.safeParse({ ...model, extra: true }).success).toBe(false);
    expect(contextSchema.safeParse({ ...context, extra: true }).success).toBe(false);
    expect(optionsSchema.safeParse({ reasoning: 'provider-high' }).success).toBe(false);
  });

  it('accepts optional arbitrary Tool Result details', () => {
    const details = {
      source: 'tool-runtime',
      rows: [1, 2, 3],
      nested: { cached: true },
    };

    expect(
      messageSchema.safeParse({
        role: 'tool',
        callId: 'call_1',
        name: 'query_logs',
        content: [{ type: 'text', text: 'logs found' }],
        details,
        isError: false,
      }),
    ).toMatchObject({ success: true });
    expect(
      messageSchema.safeParse({
        role: 'tool',
        callId: 'call_2',
        name: 'query_logs',
        content: [{ type: 'text', text: 'logs found' }],
        isError: false,
      }),
    ).toMatchObject({ success: true });
  });

  it('keeps AbortSignal outside the serializable Options schema', () => {
    const signal = new AbortController().signal;
    expect(validateOptions({ signal }).signal).toBe(signal);
    expect(validateContext(context).messages).toHaveLength(1);
  });

  it('rejects thinking signatures that could overwrite assistant request fields', () => {
    for (const thinkingSignature of ['role', 'content', 'tool_calls']) {
      expect(
        contextSchema.safeParse({
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  role: 'assistant',
                  api: 'openai-completions',
                  provider: 'moonshot',
                  model: 'kimi-k3',
                  finishReason: 'stop',
                  content: [
                    {
                      type: 'thinking',
                      thinking: 'corrupted',
                      thinkingSignature,
                      source: {
                        api: 'openai-completions',
                        provider: 'moonshot',
                        model: 'kimi-k3'
                      }
                    }
                  ]
                }
              ],
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it('validates only the tool allowlist, leaving argument semantics to Tool Gateway', () => {
    expect(
      validateModelToolCall(context.tools, {
        callId: 'call_1',
        name: 'query_logs',
        arguments: { any: 'shape' },
      }),
    ).toMatchObject({ name: 'query_logs' });
    expect(() =>
      validateModelToolCall(context.tools, {
        callId: 'call_1',
        name: 'delete_prod',
        arguments: {},
      }),
    ).toThrowError(/not declared/);
  });

  it('emits exactly one terminal event and resolves the matching result', async () => {
    const stream = createModelEventStream(async (controller) => {
      const partial = {
        role: 'assistant' as const,
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [],
        finishReason: 'pending' as const,
      };
      controller.emit({ type: 'start', model, partial });
      controller.emit({
        type: 'text.delta',
        contentIndex: 0,
        delta: 'hello',
        partial: { ...partial, content: [{ type: 'text' as const, text: 'hello' }] },
      });
      controller.complete({
        role: 'assistant',
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: [{ type: 'text', text: 'hello' }],
        toolCalls: [],
        finishReason: 'stop',
      });
    });
    const events = [];
    for await (const event of stream) events.push(event);
    await expect(stream.result()).resolves.toMatchObject({ content: [{ text: 'hello' }] });
    expect(events.map((event) => event.type)).toEqual(['start', 'text.delta', 'done']);
  });

  it('resolves an error terminal message and emits the matching error event', async () => {
    const errorMessage = {
      role: 'assistant' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      finishReason: 'error' as const,
      errorMessage: 'Timed out.',
    };
    const stream = createModelEventStream(async (controller) => controller.error(errorMessage));
    const events = [];
    for await (const event of stream) events.push(event);
    await expect(stream.result()).resolves.toBe(errorMessage);
    expect(events.at(-1)).toEqual({
      type: 'error',
      reason: 'error',
      error: errorMessage,
    });
  });

  it('resolves an aborted terminal message', async () => {
    const abortedMessage = {
      role: 'assistant' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      finishReason: 'aborted' as const,
      errorMessage: 'Request aborted.',
    };
    const stream = createModelEventStream(async (controller) => controller.error(abortedMessage));
    const events = [];
    for await (const event of stream) events.push(event);
    await expect(stream.result()).resolves.toBe(abortedMessage);
    expect(events.at(-1)).toMatchObject({ reason: 'aborted', error: abortedMessage });
  });

  it('keeps the terminal protocol single-shot', async () => {
    const success = {
      role: 'assistant' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      finishReason: 'stop' as const,
    };
    const failure = { ...success, finishReason: 'error' as const, errorMessage: 'failed' };
    const stream = createModelEventStream(async (controller) => {
      controller.complete(success);
      controller.error(failure);
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.map((event) => event.type)).toEqual(['done']);
    await expect(stream.result()).resolves.toBe(success);
  });

  it('rejects an unexpected producer exception without inventing an error message', async () => {
    const failure = new Error('programmer failure');
    const stream = createModelEventStream(async () => {
      throw failure;
    });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([]);
    await expect(stream.result()).rejects.toBe(failure);
  });
});
