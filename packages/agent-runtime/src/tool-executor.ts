import type{ ModelToolCall, ToolResultMessage } from '@opspilot/model-gateway';
import { type AgentTool } from './types.js';

export async function executeToolCall(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  signal?: AbortSignal,
): Promise<ToolResultMessage>{
    const tool = tools.find((t) => t.name === toolCall.name);

    if (!tool) {
        return {
            role: 'tool',
            callId: toolCall.callId,
            name: toolCall.name,
            content: [
                {
                    type: 'text',
                    text: `Tool "${toolCall.name}" not found.`,
                },
            ],
            isError: true,
        };
    }

    try {
        const result = await tool.execute(
            toolCall.callId,
            toolCall.arguments,
            signal,
        );

        return {
            role: 'tool',
            callId: toolCall.callId,
            name: toolCall.name,
            content: result.content,
            isError: false,
        };
    }catch (error) {
        
        const message =error instanceof Error ? error.message : String(error);
            
        return {
            role: 'tool',
            callId: toolCall.callId,
            name: toolCall.name,
            content: [
                {
                    type: 'text',
                    text: message,
                },
            ],
            isError: true,
        };
    }
}