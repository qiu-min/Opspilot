import type {
  Context,
  JsonObject,
  Model,
  ModelEventStream,
  ModelGateway,
  ModelToolCall,
  Options,
  TextContent,
  Tool,
} from '@opspilot/model-gateway';

export interface AgentToolResult {
  content: TextContent[];
  isError?: boolean;
}
    
export interface AgentTool extends Tool {
  execute(
    callId: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
}

export interface AgentContext {
  readonly systemPrompt: string;
  readonly messages: Context['messages'];
  readonly tools?: readonly AgentTool[];
}

export type StreamFn = (
  model: Model,
  context: Context,
  options?: Options,
) => ModelEventStream;
    
export interface AgentLoopConfig {
  readonly model: Model;
  readonly maxTurns?: number;
}