import { describe, expect, it } from 'vitest';
import { createModelEventStream, ModelGatewayError, type Model } from '@opspilot/model-gateway';

import { runAgentLoop } from '../src/agent-loop.js';
import type { AgentContext, AgentEvent } from '../src/types.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

const context: AgentContext = {
  messages: [
    {
      role: 'user',
      content: [{ type: 'text', text: 'Investigate the alert.' }],
    },
  ],
};

const config = { model };

const assistantMessage = {
  role: 'assistant' as const,
  api: model.api,
  provider: model.provider,
  model: model.id,
  content: [{ type: 'text' as const, text: 'The alert is understood.' }],
  finishReason: 'stop' as const,
};

describe('runAgentLoop model event mapping', () => {
  it('maps a text stream while preserving the final assistant message', async () => {
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
    const events: AgentEvent[] = [];

    await runAgentLoop(
      context,
      config,
      () => stream,
      (event) => {
        events.push(event);
      },
    );

    expect(events.map((event) => event.type)).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_update',
      'message_update',
      'message_update',
      'message_end',
      'turn_end',
      'agent_end',
    ]);
    expect(events[2]).toEqual({ type: 'message_start' });
    const messageUpdates = events.filter((event) => event.type === 'message_update');
    expect(messageUpdates).toEqual([
      { type: 'message_update', event: firstDelta },
      { type: 'message_update', event: secondDelta },
      { type: 'message_update', event: usage },
    ]);
    expect(messageUpdates[0]?.event).toBe(firstDelta);
    expect(messageUpdates[1]?.event).toBe(secondDelta);
    expect(messageUpdates[2]?.event).toBe(usage);

    const messageEnd = events.find((event) => event.type === 'message_end');
    const turnEnd = events.find((event) => event.type === 'turn_end');
    expect(messageEnd?.message).toBe(assistantMessage);
    expect(turnEnd?.message).toBe(assistantMessage);
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
        context,
        config,
        () => stream,
        () => undefined,
      ),
    ).rejects.toBe(error);
  });
});
