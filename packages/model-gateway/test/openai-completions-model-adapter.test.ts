import { describe, expect, it } from 'vitest';
import {
  OpenAiCompletionsModelAdapter,
  type OpenAiCompletionsClient,
  type OpenAiCompletionsRequest,
  type ResolvedProvider,
} from '../src/index.js';
import { resolveThinking } from '../src/thinking.js';

const provider: ResolvedProvider = {
  id: 'moonshot',
  name: 'Moonshot',
  apiKey: 'key',
  baseUrl: 'https://moonshot.example/v1',
  models: [],
};
const model = {
  provider: 'moonshot',
  id: 'kimi',
  name: 'Kimi',
  api: 'openai-completions',
  baseUrl: 'https://moonshot.example/v1',
  supportsTools: true,
  reasoning: true,
  reasoningProtocol: 'openai-reasoning-effort' as const,
  thinkingLevelMap: { off: 'none', minimal: 'low', low: 'low', medium: 'medium', high: 'high' },
};
const k3Model = {
  ...model,
  id: 'kimi-k3',
  thinkingLevelMap: { off: null, minimal: 'low', low: 'low', medium: 'high', high: 'max' },
  compat: {
    maxTokensField: 'max_completion_tokens' as const,
    supportsTemperature: false,
    requiresReasoningContentOnAssistantMessages: true,
  },
};
const context = {
  systemPrompt: 'You investigate production incidents.',
  messages: [
    { role: 'user' as const, content: [{ type: 'text' as const, text: 'Inspect logs.' }] },
  ],
  tools: [
    {
      name: 'query_logs',
      description: 'Read logs.',
      parameters: { type: 'object', properties: {} },
    },
  ],
};
function stream(...items: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    yield* items;
  })();
}
describe('OpenAI Chat Completions adapter', () => {
  it('normalizes text, tool calls, usage, and sends the configured endpoint', async () => {
    const requests: OpenAiCompletionsRequest[] = [];
    let endpoint = '';
    const client: OpenAiCompletionsClient = {
      chat: {
        completions: {
          async create(input) {
            requests.push(input);
            return stream(
              { id: 'chat_1', choices: [{ delta: { content: 'Checking ' }, finish_reason: null }] },
              { choices: [{ delta: { content: 'logs' }, finish_reason: null }] },
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          function: { name: 'query_logs', arguments: '{}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
              { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } },
            );
          },
        },
      },
    };
    const adapter = new OpenAiCompletionsModelAdapter((_provider, url) => {
      endpoint = url;
      return client;
    });
    const received = [];
    const result = adapter.stream(
      model,
      context,
      resolveThinking(model, { reasoning: 'high' }),
      provider,
    );
    for await (const event of result) received.push(event);
    await expect(result.result()).resolves.toMatchObject({
      content: [{ text: 'Checking logs' }],
      toolCalls: [{ callId: 'call_1', name: 'query_logs' }],
      usage: { totalTokens: 6 },
    });
    expect(received.map((event) => event.type)).toEqual([
      'start',
      'text.delta',
      'text.delta',
      'tool-call.delta',
      'usage',
      'tool-call.completed',
      'done',
    ]);
    expect(endpoint).toBe('https://moonshot.example/v1');
    expect(requests[0]).toMatchObject({
      model: 'kimi',
      stream: true,
      tool_choice: 'auto',
      reasoning_effort: 'high',
      tools: [{ type: 'function', function: { name: 'query_logs' } }],
    });
  });
  it('serializes assistant tool calls for a following tool result', async () => {
    let sent: OpenAiCompletionsRequest | undefined;
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create(input) {
            sent = input;
            return stream({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] });
          },
        },
      },
    }));
    const result = adapter.stream(
      model,
      {
        ...context,
        messages: [
          {
            role: 'assistant',
            content: [],
            toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: {} }],
          },
          {
            role: 'tool',
            callId: 'call_1',
            name: 'query_logs',
            content: [{ type: 'text', text: 'result' }],
            isError: false,
          },
        ],
      },
      {
        responseFormat: {
          name: 'summary',
          schema: { type: 'object', properties: {} },
          strict: true,
        },
      },
      provider,
    );
    await result.result();
    expect(sent?.messages).toMatchObject([
      { role: 'system', content: 'You investigate production incidents.' },
      { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1' },
    ]);
    expect(sent?.response_format).toMatchObject({ type: 'json_schema' });
    expect(sent).not.toHaveProperty('reasoning_effort');
  });

  it('maps reasoning formats from resolved options without leaking format choices upward', async () => {
    const sent: OpenAiCompletionsRequest[] = [];
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create(input) {
            sent.push(input);
            return stream({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] });
          },
        },
      },
    }));
    for (const reasoningProtocol of ['openai-reasoning-object', 'deepseek-thinking'] as const) {
      const reasoner = { ...model, reasoningProtocol };
      await adapter
        .stream(reasoner, context, resolveThinking(reasoner, { reasoning: 'medium' }), provider)
        .result();
    }
    expect(sent[0]).toMatchObject({ reasoning: { effort: 'medium' } });
    expect(sent[1]).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
    });
  });

  it('uses K3 request fields and preserves independent streamed reasoning, text, and tool calls', async () => {
    let sent: OpenAiCompletionsRequest | undefined;
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create(input) {
            sent = input;
            return stream(
              { choices: [{ delta: { reasoning_content: 'first ' }, finish_reason: null }] },
              {
                choices: [
                  {
                    delta: {
                      reasoning_content: 'second',
                      content: 'answer',
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          function: { name: 'query_logs', arguments: '{}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              },
            );
          },
        },
      },
    }));
    const events = [];
    const result = adapter.stream(
      k3Model,
      context,
      resolveThinking(k3Model, { reasoning: 'medium', maxTokens: 32768 }),
      provider,
    );
    for await (const event of result) events.push(event);
    await expect(result.result()).resolves.toMatchObject({
      content: [
        { type: 'thinking', thinking: 'first second', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'answer' },
      ],
    });
    expect(events.map((event) => event.type)).not.toContain('thinking.delta');
    expect(events.filter((event) => event.type === 'text.delta')).toHaveLength(1);
    expect(sent).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 32768 });
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent).not.toHaveProperty('reasoning');
    expect(sent).not.toHaveProperty('thinking');
  });

  it('replays K3 reasoning_content with tool calls and omits empty tool declarations', async () => {
    let sent: OpenAiCompletionsRequest | undefined;
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create(input) {
            sent = input;
            return stream({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] });
          },
        },
      },
    }));
    await adapter
      .stream(
        k3Model,
        {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'thinking',
                  thinking: 'private chain',
                  thinkingSignature: 'reasoning_content',
                },
              ],
              toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: {} }],
            },
            {
              role: 'tool',
              callId: 'call_1',
              name: 'query_logs',
              content: [{ type: 'text', text: 'ok' }],
              isError: false,
            },
          ],
        },
        {},
        provider,
      )
      .result();
    expect(sent?.messages).toMatchObject([
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'private chain',
        tool_calls: [{ id: 'call_1' }],
      },
      { role: 'tool', tool_call_id: 'call_1' },
    ]);
    expect(sent).not.toHaveProperty('tools');
    expect(sent).not.toHaveProperty('tool_choice');
  });

  it('rejects an explicit K3 temperature before making a provider request', async () => {
    let invoked = false;
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            invoked = true;
            return stream();
          },
        },
      },
    }));
    await expect(
      adapter.stream(k3Model, context, { temperature: 0.2 }, provider).result(),
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
    });
    expect(invoked).toBe(false);
  });

  it('keeps standard OpenAI requests free of K3 compatibility fields', async () => {
    let sent: OpenAiCompletionsRequest | undefined;
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create(input) {
            sent = input;
            return stream({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] });
          },
        },
      },
    }));
    await adapter
      .stream(
        { ...model, provider: 'openai', reasoning: false },
        { messages: context.messages },
        { maxTokens: 12 },
        provider,
      )
      .result();
    expect(sent).toMatchObject({ max_tokens: 12 });
    expect(sent).not.toHaveProperty('reasoning_content');
  });
});
