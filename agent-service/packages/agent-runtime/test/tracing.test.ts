import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, expect, it } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type FinishReason,
  type Model,
  type ModelEventStream,
  type ModelToolCall,
  type Usage,
} from '@opspilot/model-gateway';

import {
  Agent,
  type AgentAttributeValue,
  type AgentSpan,
  type AgentSpanOptions,
  type AgentTracer,
  type AgentTool,
  type StreamFn,
} from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

interface RecordedSpan {
  readonly name: string;
  readonly attributes: Record<string, AgentAttributeValue>;
  readonly exceptions: unknown[];
  readonly parent?: RecordedSpan;
  status?: { readonly code: string; readonly message?: string };
  ended: boolean;
}

/** Records span relationships through async context, including parallel sibling spans. */
class RecordingTracer implements AgentTracer {
  public readonly spans: RecordedSpan[] = [];
  private readonly active = new AsyncLocalStorage<readonly RecordedSpan[]>();

  /** Starts a recording span, runs its callback in async scope, and closes it. */
  public async withSpan<T>(
    name: string,
    options: AgentSpanOptions,
    operation: (span: AgentSpan) => Promise<T>,
  ): Promise<T> {
    const span: RecordedSpan = {
      name,
      attributes: { ...(options.attributes ?? {}) },
      exceptions: [],
      parent: this.active.getStore()?.at(-1),
      ended: false,
    };
    this.spans.push(span);
    return await this.active.run([...(this.active.getStore() ?? []), span], async () => {
      try {
        return await operation({
          setAttribute: (key, value) => {
            span.attributes[key] = value;
          },
          setAttributes: (attributes) => {
            Object.assign(span.attributes, attributes);
          },
          recordException: (exception) => {
            span.exceptions.push(exception);
          },
          setStatus: (code, message) => {
            span.status = { code, ...(message === undefined ? {} : { message }) };
          },
        });
      } finally {
        span.ended = true;
      }
    });
  }
}

/** Creates a standard test assistant response. */
function assistantMessage(
  finishReason: FinishReason,
  toolCalls?: readonly ModelToolCall[],
  usage?: Usage,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    finishReason,
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(usage === undefined ? {} : { usage }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

/** Creates a finite model stream and optionally publishes a usage event before completion. */
function assistantStream(message: AssistantMessage, usage?: Usage): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model,
      partial: { ...message, finishReason: 'pending' },
    });
    if (usage !== undefined) {
      controller.emit({
        type: 'usage',
        usage,
        partial: { ...message, finishReason: 'pending', usage },
      });
    }
    controller.complete(message);
  });
}

/** Creates a valid no-argument test Tool. */
function createTool(
  name: string,
  execute: AgentTool['execute'] = async () => ({ content: [] }),
): AgentTool {
  return {
    name,
    description: `Test tool ${name}`,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute,
  };
}

/** Returns model streams in deterministic request order. */
function createStreamFn(streams: readonly ModelEventStream[]): StreamFn {
  let index = 0;
  return () => {
    const stream = streams[index];
    index += 1;
    if (stream === undefined) throw new Error('Unexpected extra model call.');
    return stream;
  };
}

/** Creates a deferred completion signal for the parallel Tool test. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('Agent Runtime tracing', () => {
  it('keeps normal execution unchanged and records the model/tool hierarchy and usage', async () => {
    const tracer = new RecordingTracer();
    const usage = { inputTokens: 3, outputTokens: 5, totalTokens: 8 };
    const call = { callId: 'call-1', name: 'lookup', arguments: {} };
    const agent = new Agent({
      model,
      tracer,
      tools: [createTool('lookup')],
      streamFn: createStreamFn([
        assistantStream(assistantMessage('tool_calls', [call], usage), usage),
        assistantStream(assistantMessage('stop')),
      ]),
    });

    await expect(
      agent.prompt({ role: 'user', content: [{ type: 'text', text: 'lookup' }] }),
    ).resolves.toHaveLength(4);

    expect(tracer.spans.map((span) => span.name)).toEqual([
      'agent.run',
      'agent.model_call',
      'agent.tool_execution',
      'agent.model_call',
    ]);
    const root = tracer.spans[0];
    const modelSpan = tracer.spans[1];
    const toolSpan = tracer.spans[2];
    expect(root?.parent).toBeUndefined();
    expect(modelSpan?.parent).toBe(root);
    expect(toolSpan?.parent).toBe(root);
    expect(modelSpan?.attributes).toMatchObject({
      'agent.model_call.id': expect.any(String),
      'agent.model_call.provider': model.provider,
      'agent.model_call.model': model.id,
      'agent.model_call.input_tokens': usage.inputTokens,
      'agent.model_call.output_tokens': usage.outputTokens,
      'agent.model_call.total_tokens': usage.totalTokens,
    });
    expect(toolSpan?.attributes).toEqual({
      'agent.tool.call_id': call.callId,
      'agent.tool.name': call.name,
    });
    expect(tracer.spans.every((span) => span.ended)).toBe(true);
    expect(root?.status?.code).toBe('ok');
  });

  it('records model failures and preserves the normalized model error result', async () => {
    const tracer = new RecordingTracer();
    const failure = assistantMessage('error', undefined, undefined, 'model failed');
    const agent = new Agent({
      model,
      tracer,
      streamFn: () =>
        createModelEventStream(async (controller) => {
          controller.error(failure);
        }),
    });

    await expect(
      agent.prompt({ role: 'user', content: [{ type: 'text', text: 'fail' }] }),
    ).resolves.toEqual([{ role: 'user', content: [{ type: 'text', text: 'fail' }] }, failure]);

    const modelSpan = tracer.spans.find((span) => span.name === 'agent.model_call');
    expect(modelSpan?.status?.code).toBe('error');
    expect(modelSpan?.exceptions).toHaveLength(1);
    expect(tracer.spans[0]?.status?.code).toBe('error');
  });

  it('records Tool errors without changing the Runtime terminal error semantics', async () => {
    const tracer = new RecordingTracer();
    const toolFailure = new Error('tool failed');
    const call = { callId: 'call-error', name: 'broken', arguments: {} };
    const agent = new Agent({
      model,
      tracer,
      tools: [
        createTool('broken', async () => {
          throw toolFailure;
        }),
      ],
      streamFn: createStreamFn([assistantStream(assistantMessage('tool_calls', [call]))]),
    });

    const messages = await agent.prompt({ role: 'user', content: [{ type: 'text', text: 'run' }] });
    const toolSpan = tracer.spans.find((span) => span.name === 'agent.tool_execution');

    expect(toolSpan?.status?.code).toBe('error');
    expect(toolSpan?.exceptions).toEqual([toolFailure]);
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      finishReason: 'error',
      errorMessage: 'Tool execution failed due to an internal error.',
    });
    expect(agent.state.errorInfo?.source).toBe('runtime');
  });

  it('creates parallel Tool spans as siblings under the Agent Run', async () => {
    const tracer = new RecordingTracer();
    const release = deferred();
    let startedCount = 0;
    const started = deferred();
    const execute = async () => {
      startedCount += 1;
      if (startedCount === 2) started.resolve();
      await release.promise;
      return { content: [] };
    };
    const calls = [
      { callId: 'call-a', name: 'tool-a', arguments: {} },
      { callId: 'call-b', name: 'tool-b', arguments: {} },
    ];
    const agent = new Agent({
      model,
      tracer,
      toolExecution: 'parallel',
      tools: [createTool('tool-a', execute), createTool('tool-b', execute)],
      streamFn: createStreamFn([
        assistantStream(assistantMessage('tool_calls', calls)),
        assistantStream(assistantMessage('stop')),
      ]),
    });

    const run = agent.prompt({ role: 'user', content: [{ type: 'text', text: 'parallel' }] });
    await started.promise;
    release.resolve();
    await run;

    const root = tracer.spans.find((span) => span.name === 'agent.run');
    const toolSpans = tracer.spans.filter((span) => span.name === 'agent.tool_execution');
    expect(toolSpans).toHaveLength(2);
    expect(toolSpans.map((span) => span.parent)).toEqual([root, root]);
  });

  it('uses the no-op tracer by default', async () => {
    const agent = new Agent({
      model,
      streamFn: createStreamFn([assistantStream(assistantMessage('stop'))]),
    });

    await expect(
      agent.prompt({ role: 'user', content: [{ type: 'text', text: 'no telemetry' }] }),
    ).resolves.toHaveLength(2);
  });

  it('falls back to normal execution when the injected tracer itself fails', async () => {
    const tracerFailure = new Error('telemetry unavailable');
    const tracer: AgentTracer = {
      withSpan: async () => {
        throw tracerFailure;
      },
    };
    const agent = new Agent({
      model,
      tracer,
      streamFn: createStreamFn([assistantStream(assistantMessage('stop'))]),
    });

    await expect(
      agent.prompt({ role: 'user', content: [{ type: 'text', text: 'telemetry failure' }] }),
    ).resolves.toHaveLength(2);
  });
});
