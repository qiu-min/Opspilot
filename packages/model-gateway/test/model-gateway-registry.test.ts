import { describe, expect, it } from 'vitest';
import { createModelGateway, type ModelAdapter } from '../src/index.js';

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
    expect(() => gateway.stream({ ...model, provider: 'unknown' }, context)).toThrowError(
      expect.objectContaining({ code: 'CONFIGURATION' }),
    );
  });
});
