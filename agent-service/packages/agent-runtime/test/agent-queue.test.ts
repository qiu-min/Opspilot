import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@opspilot/model-gateway';

import { Agent } from '../src/index.js';
import { runAgentLoopWithOutcome } from '../src/agent-loop.js';
import type { AgentLoopConfig, AgentMessage } from '../src/index.js';

vi.mock('../src/agent-loop.js', () => ({
  runAgentLoopWithOutcome: vi.fn(),
}));

const mockedRunAgentLoop = vi.mocked(runAgentLoopWithOutcome);

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

/** 创建一个不启动真实模型请求的 Agent。
 * @returns 使用测试模型和空 Loop 结果的 Agent。
 */
function createAgent(): Agent {
  return new Agent({
    model,
    streamFn: () => {
      throw new Error('The queue tests must not start a model stream.');
    },
  });
}

describe('Agent message queues', () => {
  beforeEach(() => {
    mockedRunAgentLoop.mockReset();
    mockedRunAgentLoop.mockImplementation(async (prompts) => ({ messages: [...prompts] }));
  });

  it('enqueues steering messages in FIFO order and drains them once', async () => {
    const agent = createAgent();
    const first = userMessage('steering A');
    const second = userMessage('steering B');
    agent.steer(first);
    agent.steer(second);

    await agent.prompt(userMessage('run'));
    const config = mockedRunAgentLoop.mock.calls[0]?.[2];

    expect(agent.hasQueuedMessages()).toBe(true);
    expect(await config?.getSteeringMessages?.()).toEqual([first, second]);
    expect(await config?.getSteeringMessages?.()).toEqual([]);
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('enqueues follow-up messages in FIFO order and drains them once', async () => {
    const agent = createAgent();
    const first = userMessage('follow-up A');
    const second = userMessage('follow-up B');
    agent.followUp(first);
    agent.followUp(second);

    await agent.prompt(userMessage('run'));
    const config = mockedRunAgentLoop.mock.calls[0]?.[2];

    expect(await config?.getFollowUpMessages?.()).toEqual([first, second]);
    expect(await config?.getFollowUpMessages?.()).toEqual([]);
  });

  it('supports batch enqueue while keeping each queue independent', async () => {
    const agent = createAgent();
    const steering = [userMessage('steering A'), userMessage('steering B')];
    const followUp = [userMessage('follow-up A'), userMessage('follow-up B')];
    agent.steer(steering);
    agent.followUp(followUp);

    await agent.prompt(userMessage('run'));
    const config = mockedRunAgentLoop.mock.calls[0]?.[2];

    expect(await config?.getSteeringMessages?.()).toEqual(steering);
    expect(await config?.getFollowUpMessages?.()).toEqual(followUp);
  });

  it('clears only the steering queue', () => {
    const agent = createAgent();
    agent.steer(userMessage('steering'));
    agent.followUp(userMessage('follow-up'));

    agent.clearSteeringQueue();

    expect(agent.hasQueuedMessages()).toBe(true);
    agent.clearFollowUpQueue();
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('clears only the follow-up queue', () => {
    const agent = createAgent();
    agent.steer(userMessage('steering'));
    agent.followUp(userMessage('follow-up'));

    agent.clearFollowUpQueue();

    expect(agent.hasQueuedMessages()).toBe(true);
    agent.clearSteeringQueue();
    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('clears both queues with clearAllQueues', () => {
    const agent = createAgent();
    agent.steer(userMessage('steering'));
    agent.followUp(userMessage('follow-up'));

    agent.clearAllQueues();

    expect(agent.hasQueuedMessages()).toBe(false);
  });

  it('reset clears transcript and both queues while keeping configuration', async () => {
    const agent = createAgent();
    const history = userMessage('history');
    await agent.prompt(history);
    agent.steer(userMessage('steering'));
    agent.followUp(userMessage('follow-up'));

    agent.reset();

    expect(agent.state.messages).toEqual([]);
    expect(agent.hasQueuedMessages()).toBe(false);
    expect(agent.state.model).toBe(model);
  });

  it('abort does not clear queued messages', () => {
    const agent = createAgent();
    agent.steer(userMessage('steering'));
    agent.followUp(userMessage('follow-up'));

    agent.abort();

    expect(agent.hasQueuedMessages()).toBe(true);
  });

  it('does not put queued messages into the transcript', () => {
    const history = userMessage('history');
    const agent = new Agent({
      model,
      messages: [history],
      streamFn: () => {
        throw new Error('The queue tests must not start a model stream.');
      },
    });
    agent.steer(userMessage('steering'));
    agent.followUp(userMessage('follow-up'));

    expect(agent.state.messages).toEqual([history]);
    expect(agent.hasQueuedMessages()).toBe(true);
  });

  it('accepts synchronous and asynchronous queue callbacks in AgentLoopConfig', async () => {
    const message = userMessage('callback message');
    const config: AgentLoopConfig = {
      model,
      getSteeringMessages: async () => [message],
      getFollowUpMessages: () => [message],
    };

    expect(await config.getSteeringMessages?.()).toEqual([message]);
    expect(await config.getFollowUpMessages?.()).toEqual([message]);
  });
});
