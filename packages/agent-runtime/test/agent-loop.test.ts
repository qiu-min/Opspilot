import { describe, expect, it } from 'vitest';
import {
  createModelEventStream,
  ModelGatewayError,
  type Context,
  type Message,
  type Model,
} from '@opspilot/model-gateway';

import { runAgentLoop } from '../src/index.js';
import type { AgentContext, AgentEvent, AgentMessage, StreamFn } from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

const historicalMessages: AgentMessage[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Investigate the first alert.' }],
  },
  {
    role: 'assistant',
    api: model.api,
    provider: model.provider,
    model: model.id,
    content: [{ type: 'text', text: 'The first alert was investigated.' }],
    finishReason: 'stop',
  },
];

const context: AgentContext = {
  messages: historicalMessages,
};

const prompt: AgentMessage = {
  role: 'user',
  content: [{ type: 'text', text: 'Investigate the second alert.' }],
};

const config = { model };

const assistantMessage = {
  role: 'assistant' as const,
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: 'text' as const, text: 'The second alert is understood.' }],
  finishReason: 'stop' as const,
};

describe('runAgentLoop message state', () => {
  it('passes history and prompts to the model and returns only new messages', async () => {
    const firstDelta = { type: 'text.delta' as const, contentIndex: 0, delta: 'The alert ' };
    const secondDelta = {
      type: 'text.delta' as const,
      contentIndex: 0,
      delta: 'is understood.',
    };
    const usage = {
      type: 'usage' as const,
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    };
    const stream = createModelEventStream(async (controller) => {
      controller.emit({ type: 'start', model });
      controller.emit(firstDelta);
      controller.emit(secondDelta);
      controller.emit(usage);
      controller.complete(assistantMessage);
    });
    const observedContexts: Context[] = [];
    const streamFn: StreamFn = (_model, modelContext) => {
      observedContexts.push(modelContext);
      return stream;
    };
    const events: AgentEvent[] = [];

    const result = await runAgentLoop([prompt], context, config, streamFn, (event) => {
      events.push(event);
    });

    expect(observedContexts[0]?.messages).toEqual([...historicalMessages, prompt]);
    expect(context.messages).toEqual(historicalMessages);
    expect(result).toEqual([prompt, assistantMessage]);
    expect(result[0]).toBe(prompt);
    expect(result[1]).toBe(assistantMessage);

    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_update',
      'message_update',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events[2]).toEqual({ type: 'message_start', message: prompt });
    expect(events[3]).toEqual({ type: 'message_end', message: prompt });
    expect(events[4]).toEqual({ type: 'message_start' });

    const messageUpdates = events.filter((event) => event.type === 'message_update');
    expect(messageUpdates[0]?.event).toBe(firstDelta);
    expect(messageUpdates[1]?.event).toBe(secondDelta);
    expect(messageUpdates[2]?.event).toBe(usage);

    expect(events[8]).toEqual({ type: 'message_end', message: assistantMessage });
    expect(events[9]).toEqual({ type: 'turn_end', message: assistantMessage, toolResults: [] });
    expect(events[10]).toEqual({ type: 'agent_end', messages: result });
    expect(events[10].type === 'agent_end' && events[10].messages).toBe(result);
  });

  it('maps tool-call stream events without executing the tool', async () => {
    const toolCall = {
      callId: 'call_1',
      name: 'query_logs',
      arguments: { service: 'api' },
    };
    const stream = createModelEventStream(async (controller) => {
      controller.emit({ type: 'start', model });
      controller.emit({ type: 'tool-call.delta', contentIndex: 0, callId: 'call_1', delta: '{' });
      controller.emit({ type: 'tool-call.completed', contentIndex: 0, toolCall });
      controller.complete({
        ...assistantMessage,
        content: [],
        toolCalls: [toolCall],
        finishReason: 'tool_calls',
      });
    });

    const events: AgentEvent[] = [];
    await runAgentLoop(
      [prompt],
      context,
      config,
      () => stream,
      (event) => {
        events.push(event);
      },
    );

    expect(events.filter((event) => event.type === 'message_update')).toEqual([
      {
        type: 'message_update',
        event: {
          type: 'tool-call.delta',
          contentIndex: 0,
          callId: 'call_1',
          delta: '{',
        },
      },
      {
        type: 'message_update',
        event: {
          type: 'tool-call.completed',
          contentIndex: 0,
          toolCall,
        },
      },
    ]);
  });

  it('propagates a model stream error through result()', async () => {
    const error = new ModelGatewayError('TIMEOUT', 'Timed out.');
    const stream = createModelEventStream(async (controller) => {
      controller.emit({ type: 'start', model });
      controller.fail(error);
    });

    await expect(
      runAgentLoop(
        [prompt],
        context,
        config,
        () => stream,
        () => undefined,
      ),
    ).rejects.toBe(error);
  });

  it('accepts a standard model Message as an AgentMessage', () => {
    const message: Message = {
      role: 'user',
      content: [{ type: 'text', text: 'A standard model message.' }],
    };
    const agentMessage: AgentMessage = message;

    expect(agentMessage).toBe(message);
  });
});
