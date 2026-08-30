import type { AgentMessage, AgentTool } from '@opspilot/agent-runtime';
import type { Model } from '@opspilot/model-gateway';

/** Input used to prepare the messages for one model call. */
export interface ContextPrepareInput {
  readonly messages: readonly AgentMessage[];
  readonly model: Model;
  readonly systemPrompt?: string;
  readonly tools: readonly AgentTool[];
  readonly signal?: AbortSignal;
}

/** Messages selected for one model call. */
export interface ContextPrepareResult {
  readonly messages: readonly AgentMessage[];
}

/** Decides which Agent messages are visible to one model call. */
export interface ContextManager {
  prepare(input: ContextPrepareInput): Promise<ContextPrepareResult>;
}
