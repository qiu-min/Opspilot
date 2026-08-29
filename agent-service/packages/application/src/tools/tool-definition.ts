import type { AgentToolResult } from '@opspilot/agent-runtime';
import type { JsonObject } from '@opspilot/model-gateway';

import type { ToolContext } from './tool-context.js';

/** Application-layer definition for a tool exposed to Agent Runtime. */
export interface ToolDefinition<TDetails = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;

  execute(
    callId: string,
    args: JsonObject,
    signal: AbortSignal | undefined,
    context: ToolContext,
  ): Promise<AgentToolResult<TDetails>>;
}
