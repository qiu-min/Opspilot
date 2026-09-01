import { describe, expect, it, vi } from 'vitest';
import type { AgentToolResult } from '@opspilot/agent-runtime';
import type { JsonObject } from '@opspilot/model-gateway';

import {
  type ToolContext,
  type ToolDefinition,
  wrapToolDefinition,
  wrapToolDefinitions,
} from '../src/index.js';

const parameters: JsonObject = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

function createDefinition(name: string, execute: ToolDefinition['execute']): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters,
    execute,
  };
}

describe('ToolDefinition wrappers', () => {
  it('preserves the AgentTool definition fields and does not execute eagerly', () => {
    const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'result' }] }));
    const definition = createDefinition('lookup', execute);

    const wrapped = wrapToolDefinition(definition, {
      sessionId: 'session-1',
      excelResource: { id: 'resource-1', filePath: 'workbook.xlsx' },
    });

    expect(wrapped.name).toBe(definition.name);
    expect(wrapped.description).toBe(definition.description);
    expect(wrapped.parameters).toBe(definition.parameters);
    expect(execute).not.toHaveBeenCalled();
  });

  it('forwards runtime execute arguments and returns the definition result', async () => {
    const context: ToolContext = {
      sessionId: 'session-1',
      excelResource: { id: 'resource-1', filePath: 'workbook.xlsx' },
    };
    const args: JsonObject = { query: 'value' };
    const signal = new AbortController().signal;
    const result: AgentToolResult<{ source: string }> = {
      content: [{ type: 'text', text: 'result' }],
      details: { source: 'fake' },
    };
    const execute = vi.fn(
      async (
        callId: string,
        receivedArgs: JsonObject,
        receivedSignal: AbortSignal | undefined,
        receivedContext: ToolContext,
      ): Promise<AgentToolResult<{ source: string }>> => {
        expect(callId).toBe('call-1');
        expect(receivedArgs).toBe(args);
        expect(receivedSignal).toBe(signal);
        expect(receivedContext).toBe(context);
        return result;
      },
    );
    const definition: ToolDefinition<{ source: string }> = {
      name: 'lookup',
      description: 'Lookup description',
      parameters,
      execute,
    };

    const returned = await wrapToolDefinition(definition, context).execute('call-1', args, signal);

    expect(returned).toBe(result);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('wraps multiple definitions in their original order', () => {
    const definitions = [
      createDefinition(
        'first',
        vi.fn(async () => ({ content: [] })),
      ),
      createDefinition(
        'second',
        vi.fn(async () => ({ content: [] })),
      ),
    ];

    const wrapped = wrapToolDefinitions(definitions, {
      sessionId: 'session-1',
      excelResource: { id: 'resource-1', filePath: 'workbook.xlsx' },
    });

    expect(wrapped.map((tool) => tool.name)).toEqual(['first', 'second']);
  });
});
