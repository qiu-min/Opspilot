import { describe, expect, it } from 'vitest';
import {
  createModelEventStream,
  type AssistantMessage,
  type Model,
  type ModelToolCall,
} from '@opspilot/model-gateway';

import { Agent, type AgentEvent, type AgentTool } from '../src/index.js';

const model: Model = {
  provider: 'test-provider',
  id: 'test-model',
  name: 'Test Model',
  api: 'test-api',
  baseUrl: 'https://model.example.test/v1',
  reasoning: false,
};

describe('Agent.continueFromToolCalls', () => {
  it('executes only the supplied calls and does not re-emit the durable assistant', async () => {
    const call: ModelToolCall = { callId: 'call-1', name: 'read', arguments: {} };
    const assistant: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      finishReason: 'tool_calls',
      toolCalls: [call],
    };
    const tool: AgentTool = {
      name: 'read',
      description: 'read',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async execute(callId) {
        return { content: [{ type: 'text', text: `result:${callId}` }] };
      },
    };
    const finalMessage: AssistantMessage = {
      ...assistant,
      content: [{ type: 'text', text: 'done' }],
      finishReason: 'stop',
      toolCalls: undefined,
    };
    const events: AgentEvent[] = [];
    const agent = new Agent({
      model,
      messages: [assistant],
      tools: [tool],
      streamFn: () =>
        createModelEventStream(async (controller) => {
          controller.complete(finalMessage);
        }),
    });
    agent.subscribe((event) => {
      events.push(event);
    });

    const result = await agent.continueFromToolCalls(assistant, [call]);

    expect(result.map((message) => message.role)).toEqual(['tool', 'assistant']);
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(
      events.filter((event) => event.type === 'message_end' && event.message === assistant),
    ).toHaveLength(0);
    expect(events.filter((event) => event.type === 'tool_execution_start')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'tool_execution_end')).toHaveLength(1);
  });
});
