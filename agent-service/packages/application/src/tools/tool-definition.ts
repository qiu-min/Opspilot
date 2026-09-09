import type { AgentToolResult } from '@opspilot/agent-runtime';
import type { JsonObject } from '@opspilot/model-gateway';

import type { ToolContext } from './tool-context.js';

/** Controls whether an interrupted tool call may be retried automatically. */
export type ToolRecoveryPolicy = 'retry_safe' | 'manual';

/** Application-layer definition for a tool exposed to Agent Runtime. */
export interface ToolDefinition<TDetails = unknown> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonObject;
  /** Omitted means manual/fail-closed during crash recovery. */
  readonly recoveryPolicy?: ToolRecoveryPolicy;
  /** Marks tools whose execution requires the durable Excel execution input. */
  readonly requiresExcelResource?: boolean;

  execute(
    callId: string,
    args: JsonObject,
    signal: AbortSignal | undefined,
    context: ToolContext,
  ): Promise<AgentToolResult<TDetails>>;
}
