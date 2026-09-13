import { describe, expect, it } from 'vitest';
import { createModelEventStream, createModelGateway, type ModelAdapter } from '../src/index.js';

const config = {
  providers: [
    {
      id: 'moonshot',
      apiKey: 'secret',
      baseUrl: 'https://moonshot.example/v1',
      models: [{ id: 'kimi', api: 'openai-completions', reasoning: false }],
    },
  ],
};
const context = {
  messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
};

describe('model gateway registry', () => {
  it('queries safe provider metadata and routes by model.api', () => {
    let called = false;
    const adapter: ModelAdapter = {
      api: 'openai-completions',
      stream() {
        called = true;
        throw new Error('stop');
      },
    };
    const gateway = createModelGateway(config, [adapter]);
    expect(gateway.getProviders()[0]).not.toHaveProperty('apiKey');
    const model = gateway.getModel('moonshot', 'kimi');
    expect(model?.baseUrl).toBe('https://moonshot.example/v1');
    expect(() => gateway.stream(model!, context)).toThrow('stop');
    expect(called).toBe(true);
  });

  it('rejects unknown adapters and providers', () => {
    expect(() =>
      createModelGateway({
        providers: [
          { ...config.providers[0]!, models: [{ id: 'x', api: 'anthropic-messages', reasoning: false }] },
        ],
      }),
    ).toThrow(/No model adapter/);
    const gateway = createModelGateway(config);
    const model = gateway.getModel('moonshot', 'kimi')!;
    expect(() => gateway.stream({ ...model, provider: 'unknown' }, context)).toThrow(
      'Unknown model provider: unknown',
    );
  });

  it('resolves a terminal model failure from complete()', async () => {
    const model = createModelGateway(config).getModel('moonshot', 'kimi')!;
    const failure = {
      role: 'assistant' as const,
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      finishReason: 'error' as const,
      errorMessage: 'Provider failed.',
    };
    const adapter: ModelAdapter = {
      api: 'openai-completions',
      stream() {
        return createModelEventStream(async (controller) => controller.error(failure));
      },
    };
    const gateway = createModelGateway(config, [adapter]);
    await expect(gateway.complete(gateway.getModel('moonshot', 'kimi')!, context)).resolves.toBe(
      failure,
    );
  });

  it('applies the Gateway retry coordinator across provider adapter attempts', async () => {
    let calls = 0;
    const adapter: ModelAdapter = {
      api: 'openai-completions',
      stream(model) {
        calls += 1;
        const response = {
          role: 'assistant' as const,
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [],
          ...(calls === 1
            ? {
                finishReason: 'error' as const,
                errorMessage: 'rate limited',
                modelError: {
                  kind: 'rate_limit' as const,
                  code: 'MODEL_RATE_LIMIT' as const,
                  message: 'Model provider rate limit exceeded.',
                  retryable: true,
                  statusCode: 429,
                },
              }
            : { finishReason: 'stop' as const }),
        };
        return createModelEventStream(async (controller) => {
          controller.emit({
            type: 'start',
            model,
            partial: { ...response, finishReason: 'pending' },
          });
          if (response.finishReason === 'error') controller.error(response);
          else controller.complete(response);
        });
      },
    };
    const gateway = createModelGateway(config, [adapter], {
      sleep: async () => undefined,
      random: () => 0.5,
    });
    const stream = gateway.stream(gateway.getModel('moonshot', 'kimi')!, context);
    const eventTypes: string[] = [];

    for await (const event of stream) eventTypes.push(event.type);

    expect(calls).toBe(2);
    expect(eventTypes).toEqual(['start', 'retry', 'done']);
    await expect(stream.result()).resolves.toMatchObject({ finishReason: 'stop' });
  });
});
