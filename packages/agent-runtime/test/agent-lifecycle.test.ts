import { describe, expect, it } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type FinishReason,
  type Model,
  type ModelEventStream,
} from '@opspilot/model-gateway';

import { Agent } from '../src/index.js';
import type { AgentMessage, StreamFn } from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

/** 创建测试用的用户消息。
 * @param text 消息文本。
 * @returns 一条 Agent 用户消息。
 */
function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  };
}

/** 创建模型返回的 assistant 消息。
 * @param finishReason 本次模型响应的结束原因。
 * @returns 一条标准 assistant 消息。
 */
function assistantMessage(finishReason: FinishReason = 'stop'): AssistantMessage {
  return {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [],
    finishReason,
  };
}

/** 创建只返回一条 assistant 消息的模型事件流。
 * @param message 本次模型响应的 assistant 消息。
 * @returns 可被 Agent 消费的模型事件流。
 */
function assistantStream(message: AssistantMessage): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

/** 创建按顺序返回模型流的函数。
 * @param streams 各次模型调用对应的事件流。
 * @returns 按调用顺序消费事件流的 StreamFn。
 */
function sequentialStreamFn(streams: readonly ModelEventStream[]): StreamFn {
  let index = 0;
  return () => {
    const stream = streams[index];
    index += 1;
    if (stream === undefined) throw new Error('Unexpected extra model call.');
    return stream;
  };
}

/** 创建一个可由测试主动完成的异步通知。
 * @returns 包含等待 Promise 和完成函数的 deferred 对象。
 */
function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

/** 创建一个模型开始后保持运行的阻塞事件流。
 * @param message 释放后返回的 assistant 消息。
 * @param started 模型开始执行时完成的通知。
 * @param release 允许模型完成的通知。
 * @returns 释放前不会结束的模型事件流。
 */
function blockingStream(
  message: AssistantMessage,
  started: { readonly resolve: () => void },
  release: { readonly promise: Promise<void> },
): ModelEventStream {
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    started.resolve();
    await release.promise;
    controller.complete(message);
  });
}

describe('Agent run lifecycle', () => {
  it('keeps an active lifecycle during execution and resolves waitForIdle after cleanup', async () => {
    const started = createDeferred();
    const release = createDeferred();
    const prompt = userMessage('initial');
    const assistant = assistantMessage();
    const agent = new Agent({
      model,
      streamFn: () => blockingStream(assistant, started, release),
    });

    const run = agent.prompt(prompt);
    await started.promise;
    const signal = agent.signal;
    let idleResolved = false;
    const idle = agent.waitForIdle().then(() => {
      idleResolved = true;
    });

    expect(agent.state.isRunning).toBe(true);
    expect(signal).toBeDefined();
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    release.resolve();
    await run;
    await idle;

    expect(agent.state.isRunning).toBe(false);
    expect(agent.signal).toBeUndefined();
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.pendingToolCalls).toEqual([]);
    expect(agent.state.messages).toEqual([prompt, assistant]);
  });

  it('resolves waitForIdle immediately when no run is active', async () => {
    const agent = new Agent({
      model,
      streamFn: sequentialStreamFn([]),
    });

    await agent.waitForIdle();

    expect(agent.state.isRunning).toBe(false);
    expect(agent.signal).toBeUndefined();
  });

  it('completes model error lifecycle and preserves the failure message', async () => {
    const history = userMessage('history');
    const failure: AssistantMessage = {
      ...assistantMessage('error'),
      errorMessage: 'model failed',
    };
    const prompt = userMessage('failed');
    const agent = new Agent({
      model,
      messages: [history],
      streamFn: () =>
        createModelEventStream(async (controller) => {
          controller.emit({ type: 'start', model, partial: assistantMessage('pending') });
          controller.error(failure);
        }),
    });

    await expect(agent.prompt(prompt)).resolves.toEqual([prompt, failure]);

    expect(agent.state.messages).toEqual([history, prompt, failure]);
    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.errorMessage).toBe('model failed');
    expect(agent.state.pendingToolCalls).toEqual([]);
    expect(agent.signal).toBeUndefined();
  });

  it('cleans lifecycle when a listener rejects after the prompt message commits', async () => {
    const history = userMessage('history');
    const failure = new Error('listener failed');
    const prompt = userMessage('listener failure');
    const agent = new Agent({
      model,
      messages: [history],
      streamFn: sequentialStreamFn([assistantStream(assistantMessage())]),
    });
    agent.subscribe((event) => {
      if (event.type === 'message_end' && event.message === prompt) throw failure;
    });

    await expect(agent.prompt(prompt)).rejects.toBe(failure);

    expect(agent.state.messages).toEqual([history, userMessage('listener failure')]);
    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.streamingMessage).toBeUndefined();
    expect(agent.state.pendingToolCalls).toEqual([]);
    expect(agent.signal).toBeUndefined();
  });

  it('rejects concurrent prompts without replacing the first ActiveRun', async () => {
    const started = createDeferred();
    const release = createDeferred();
    const agent = new Agent({
      model,
      streamFn: () => blockingStream(assistantMessage(), started, release),
    });

    const firstRun = agent.prompt(userMessage('first'));
    await started.promise;
    const firstSignal = agent.signal;

    await expect(agent.prompt(userMessage('second'))).rejects.toThrow('Agent is already running.');

    expect(agent.signal).toBe(firstSignal);
    expect(agent.state.isRunning).toBe(true);
    release.resolve();
    await firstRun;
  });

  it('aborts the current ActiveRun signal', async () => {
    const started = createDeferred();
    const failure: AssistantMessage = {
      ...assistantMessage('aborted'),
      errorMessage: 'Request aborted.',
    };
    let receivedSignal: AbortSignal | undefined;
    const agent = new Agent({
      model,
      streamFn: (_model, _context, options) => {
        receivedSignal = options?.signal;
        return createModelEventStream(async (controller) => {
          controller.emit({ type: 'start', model, partial: assistantMessage('pending') });
          started.resolve();
          await new Promise<void>((resolve) => {
            receivedSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
          controller.error(failure);
        });
      },
    });

    const run = agent.prompt(userMessage('abort'));
    await started.promise;
    const signal = agent.signal;
    agent.abort();

    expect(signal).toBe(receivedSignal);
    expect(signal?.aborted).toBe(true);
    await expect(run).resolves.toEqual([userMessage('abort'), failure]);
    expect(agent.signal).toBeUndefined();
    expect(agent.state.errorMessage).toBe('Request aborted.');
  });

  it('allows a later prompt after a failed lifecycle', async () => {
    const failure: AssistantMessage = {
      ...assistantMessage('error'),
      errorMessage: 'first run failed',
    };
    let attempt = 0;
    const agent = new Agent({
      model,
      streamFn: () => {
        attempt += 1;
        if (attempt === 1) {
          return createModelEventStream(async (controller) => {
            controller.error(failure);
          });
        }
        return assistantStream(assistantMessage());
      },
    });

    await expect(agent.prompt(userMessage('first'))).resolves.toEqual([
      userMessage('first'),
      failure,
    ]);
    await expect(agent.prompt(userMessage('second'))).resolves.toHaveLength(2);
    expect(agent.state.isRunning).toBe(false);
    expect(agent.state.errorMessage).toBeUndefined();
  });
});
