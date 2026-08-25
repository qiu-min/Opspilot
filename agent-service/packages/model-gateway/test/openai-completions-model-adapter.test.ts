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
const k3ThinkingSource = {
  api: 'openai-completions',
  provider: 'moonshot',
  model: 'kimi-k3',
};
function stream(...items: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    yield* items;
  })();
}

/** 创建一个在请求创建阶段失败的测试 Adapter。
 * @param error 模拟 Provider 抛出的异常。
 * @returns 使用固定失败客户端的 OpenAI Adapter。
 */
function failingAdapter(error: unknown): OpenAiCompletionsModelAdapter {
  return new OpenAiCompletionsModelAdapter(() => ({
    chat: {
      completions: {
        async create() {
          throw error;
        },
      },
    },
  }));
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
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
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
    expect(received[0]).toMatchObject({
      type: 'start',
      partial: { finishReason: 'pending', content: [] },
    });
    expect(received.find((event) => event.type === 'text.delta')).toMatchObject({
      partial: { content: [{ type: 'text', text: 'Checking ' }], finishReason: 'pending' },
    });
    const textDeltas = received.filter((event) => event.type === 'text.delta');
    expect(textDeltas[0]?.partial.content[0]).toMatchObject({ text: 'Checking ' });
    expect(textDeltas[1]?.partial.content[0]).toMatchObject({ text: 'Checking logs' });
    expect(received.find((event) => event.type === 'usage')).toMatchObject({
      partial: { usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
    });
    expect(received.at(-1)).toMatchObject({ type: 'done', response: { finishReason: 'tool_calls' } });
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
            finishReason: 'tool_calls',
            rawFinishReason: 'tool_calls',
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            api: model.api,
            provider: model.provider,
            model: model.id,
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
        {
          type: 'thinking',
          thinking: 'first second',
          thinkingSignature: 'reasoning_content',
          source: k3ThinkingSource,
        },
        { type: 'text', text: 'answer' },
      ],
    });
    expect(events.map((event) => event.type)).toContain('thinking.delta');
    const response = await result.result();
    const textDelta = events.find((event) => event.type === 'text.delta');
    const thinkingDeltas = events.filter((event) => event.type === 'thinking.delta');
    expect(thinkingDeltas).toHaveLength(2);
    expect(thinkingDeltas.at(-1)?.partial.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'first second',
    });
    expect(textDelta).toMatchObject({
      contentIndex: response.content.findIndex((block) => block.type === 'text'),
    });
    expect(response.content.map((block) => block.type)).toEqual(['thinking', 'text']);
    expect(sent).toMatchObject({ reasoning_effort: 'high', max_completion_tokens: 32768 });
    expect(sent).not.toHaveProperty('max_tokens');
    expect(sent).not.toHaveProperty('reasoning');
    expect(sent).not.toHaveProperty('thinking');
  });

  it('publishes best-effort partial tool arguments while keeping the final call strict', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return stream(
              {
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_1',
                          function: { name: 'query_logs', arguments: '{"service":"pay' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              },
              {
                choices: [
                  {
                    delta: { tool_calls: [{ index: 0, function: { arguments: 'ments"}' } }] },
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
    const result = adapter.stream(model, context, {}, provider);
    for await (const event of result) events.push(event);

    const partialDeltas = events.filter((event) => event.type === 'tool-call.delta');
    expect(partialDeltas).toHaveLength(2);
    expect(partialDeltas[0]).toMatchObject({
      partial: { toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: { service: 'pay' } }] },
    });
    expect(partialDeltas[1]).toMatchObject({
      partial: {
        toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: { service: 'payments' } }],
      },
    });
    const completed = events.find((event) => event.type === 'tool-call.completed');
    expect(completed).toMatchObject({
      partial: { toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: { service: 'payments' } }] },
    });
    await expect(result.result()).resolves.toMatchObject({
      finishReason: 'tool_calls',
      toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: { service: 'payments' } }],
    });
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
                  source: k3ThinkingSource,
                },
              ],
              toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: {} }],
              finishReason: 'tool_calls',
              rawFinishReason: 'tool_calls',
              usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
              api: model.api,
              provider: model.provider,
              model: model.id,
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
      Promise.resolve().then(() => adapter.stream(k3Model, context, { temperature: 0.2 }, provider)),
    ).rejects.toThrow('does not support temperature');
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

  it('keeps content indexes consistent when text arrives before reasoning', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return stream(
              { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
              { choices: [{ delta: { reasoning_content: 'private' }, finish_reason: 'stop' }] },
            );
          },
        },
      },
    }));
    const events = [];
    const result = adapter.stream(k3Model, context, {}, provider);
    for await (const event of result) events.push(event);
    const response = await result.result();
    const textDelta = events.find((event) => event.type === 'text.delta');
    expect(response.content.map((block) => block.type)).toEqual(['text', 'thinking']);
    expect(textDelta).toMatchObject({
      contentIndex: response.content.findIndex((block) => block.type === 'text'),
    });
  });

  it('does not replay K3 thinking to a different provider or model', async () => {
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
    const history = {
      messages: [
        {
          role: 'assistant' as const,
          content: [
            {
              type: 'thinking' as const,
              thinking: 'k3-private',
              thinkingSignature: 'reasoning_content' as const,
              source: k3ThinkingSource,
            },
          ],
          toolCalls: [{ callId: 'call_1', name: 'query_logs', arguments: {} }],
          finishReason: 'tool_calls' as const,
          rawFinishReason: 'tool_calls',
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
          api: model.api,
          provider: model.provider,
          model: model.id,
        },
      ],
    };
    await adapter
      .stream({ ...model, provider: 'openai', reasoning: false }, history, {}, provider)
      .result();
    await adapter.stream({ ...k3Model, provider: 'other' }, history, {}, provider).result();
    await adapter.stream({ ...k3Model, id: 'other-kimi' }, history, {}, provider).result();
    const standardAssistant = sent[0]?.messages[0] as Record<string, unknown>;
    expect(standardAssistant).not.toHaveProperty('reasoning_content');
    expect(standardAssistant).not.toHaveProperty('reasoning');
    expect(standardAssistant).not.toHaveProperty('reasoning_text');
    for (const request of sent.slice(1)) {
      const assistant = request.messages[0] as Record<string, unknown>;
      expect(assistant).not.toHaveProperty('reasoning_content', 'k3-private');
      expect(assistant).not.toHaveProperty('reasoning');
      expect(assistant).not.toHaveProperty('reasoning_text');
      expect(assistant).toMatchObject({ reasoning_content: '' });
    }
  });

  it('does not duplicate a multi-field reasoning delta', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return stream({
              choices: [
                {
                  delta: { reasoning_content: 'same', reasoning: 'same', content: 'answer' },
                  finish_reason: 'stop',
                },
              ],
            });
          },
        },
      },
    }));
    const response = await adapter.stream(k3Model, context, {}, provider).result();
    expect(response.content.find((block) => block.type === 'thinking')).toMatchObject({
      thinking: 'same',
      thinkingSignature: 'reasoning_content',
    });
  });

  it('preserves raw finish reason when normalizing provider finish reason', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return stream({
              choices: [
                {
                  delta: { content: 'blocked' },
                  finish_reason: 'content_filter',
                },
              ],
            });
          },
        },
      },
    }));

    const result = await adapter
      .stream(model, context, {}, provider)
      .result();

    expect(result).toMatchObject({
      finishReason: 'refusal',
      rawFinishReason: 'content_filter',
    });
  });

  it('converts unknown provider finish reasons into an error AssistantMessage', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return stream({
              choices: [
                {
                  delta: { content: 'answer' },
                  finish_reason: 'some_new_reason',
                },
              ],
            });
          },
        },
      },
    }));

    const result = adapter.stream(model, context, {}, provider);

    await expect(result.result()).resolves.toMatchObject({
      finishReason: 'error',
      errorMessage: 'Unknown provider finish reason: some_new_reason',
    });
  });

  it('converts a stream without a finish reason into an error AssistantMessage', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return stream({
              choices: [
                {
                  delta: { content: 'answer' },
                  finish_reason: null,
                },
              ],
            });
          },
        },
      },
    }));

    const result = adapter.stream(model, context, {}, provider);

    await expect(result.result()).resolves.toMatchObject({
      finishReason: 'error',
      errorMessage: 'Model provider stream ended without a finish reason.',
    });
  });

  it('converts authentication and rate-limit Provider failures into terminal messages', async () => {
    for (const error of [
      Object.assign(new Error('unauthorized'), { status: 401 }),
      Object.assign(new Error('limited'), { status: 429 }),
    ]) {
      const result = failingAdapter(error).stream(model, context, {}, provider);
      const events = [];
      for await (const event of result) events.push(event);
      const response = await result.result();
      expect(response).toMatchObject({ finishReason: 'error' });
      expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'error', error: response });
    }
  });

  it('keeps timeout failures as error rather than aborted', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'APIConnectionTimeoutError' });
    const response = await failingAdapter(timeout).stream(model, context, {}, provider).result();
    expect(response).toMatchObject({
      finishReason: 'error',
      errorMessage: 'Model provider request timed out.',
    });
  });

  it('encodes an aborted request as an aborted terminal message', async () => {
    const controller = new AbortController();
    controller.abort();
    const response = await failingAdapter(new Error('aborted'))
      .stream(model, context, { signal: controller.signal }, provider)
      .result();
    expect(response).toMatchObject({ finishReason: 'aborted' });
  });

  it('preserves partial content when the Provider stream fails midway', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return (async function* () {
              yield { choices: [{ delta: { content: 'partial text' }, finish_reason: null }] };
              throw new Error('socket closed');
            })();
          },
        },
      },
    }));
    const response = await adapter.stream(model, context, {}, provider).result();
    expect(response).toMatchObject({
      finishReason: 'error',
      content: [{ type: 'text', text: 'partial text' }],
      errorMessage: 'socket closed',
    });
  });

  it('converts an invalid final tool call into an error terminal message', async () => {
    const adapter = new OpenAiCompletionsModelAdapter(() => ({
      chat: {
        completions: {
          async create() {
            return stream({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        function: { name: 'query_logs', arguments: '{invalid' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            });
          },
        },
      },
    }));
    const response = await adapter.stream(model, context, {}, provider).result();
    expect(response).toMatchObject({
      finishReason: 'error',
      errorMessage: 'OpenAI tool arguments must be valid JSON.',
    });
  });
});
