import { describe, expect, it } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type Model,
  type Options,
} from '@opspilot/model-gateway';

import { Agent } from '../src/index.js';
import type { AgentMessage, AgentThinkingLevel, StreamFn } from '../src/index.js';

const reasoningModel: Model = {
  provider: 'test-provider',
  id: 'reasoning-model',
  name: 'Reasoning Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: true,
  reasoningProtocol: 'openai-reasoning-effort',
  thinkingLevelMap: {
    off: 'none',
    minimal: 'low',
    low: 'low',
    medium: 'medium',
    high: 'high',
  },
};

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(): AssistantMessage {
  return {
    role: 'assistant',
    api: reasoningModel.api,
    provider: reasoningModel.provider,
    model: reasoningModel.id,
    content: [{ type: 'text', text: 'done' }],
    finishReason: 'stop',
  };
}

function assistantStream(): ReturnType<StreamFn> {
  const message = assistantMessage();
  return createModelEventStream(async (controller) => {
    controller.emit({
      type: 'start',
      model: reasoningModel,
      partial: { ...message, content: [], finishReason: 'pending' },
    });
    controller.complete(message);
  });
}

function createAgent(
  thinkingLevel: AgentThinkingLevel | undefined,
  observedOptions: Options[],
): Agent {
  return new Agent({
    model: reasoningModel,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    streamFn: (_model, _context, options) => {
      observedOptions.push(options ?? {});
      return assistantStream();
    },
  });
}

describe('Agent thinkingLevel', () => {
  it('defaults to off and does not send reasoning to the model', async () => {
    const observedOptions: Options[] = [];
    const agent = createAgent(undefined, observedOptions);

    expect(agent.state.thinkingLevel).toBe('off');
    await agent.prompt(userMessage('hello'));

    expect(observedOptions[0]?.reasoning).toBeUndefined();
  });

  it.each(['minimal', 'low', 'medium', 'high'] as const)(
    'passes %s through to the model options',
    async (thinkingLevel) => {
      const observedOptions: Options[] = [];
      const agent = createAgent(thinkingLevel, observedOptions);

      expect(agent.state.thinkingLevel).toBe(thinkingLevel);
      await agent.prompt(userMessage('hello'));

      expect(observedOptions[0]?.reasoning).toBe(thinkingLevel);
    },
  );

  it('keeps explicit off out of model options', async () => {
    const observedOptions: Options[] = [];
    const agent = createAgent('off', observedOptions);

    await agent.prompt(userMessage('hello'));

    expect(observedOptions[0]).not.toHaveProperty('reasoning');
  });
});
