import type{ ModelToolCall, ToolResultMessage } from '@opspilot/model-gateway';
import { AgentTool } from './types.js';

export async function executeToolCall(
  toolCall: ModelToolCall,
  tools: readonly AgentTool[],
  signal?: AbortSignal,
): Promise<ToolResultMessage>