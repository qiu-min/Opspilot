import type {
  AssistantMessage,
  Context,
  JsonObject,
  Message,
  Model,
  ModelEventStream,
  ModelStreamEvent,
  ModelToolCall,
  Options,
  TextContent,
  Tool,
  ToolResultMessage,
} from '@opspilot/model-gateway';

export interface AgentToolResult {
  readonly content: readonly TextContent[];
}

export interface AgentTool extends Tool {
  execute(callId: string, args: JsonObject, signal?: AbortSignal): Promise<AgentToolResult>;
}

/** 预留给业务包通过 declaration merging 扩展 Agent 消息。 */
export interface CustomAgentMessages {}

/** Agent Runtime 内部流转的标准消息或业务扩展消息。 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentContext {
  readonly systemPrompt?: string;
  messages: AgentMessage[];
  readonly tools?: readonly AgentTool[];
}

export interface AgentState {
  readonly systemPrompt?: string;
  readonly model: Model;
  readonly tools: readonly AgentTool[];
  readonly messages: readonly AgentMessage[];
  readonly isRunning: boolean;
}

export interface AgentOptions {
  readonly model: Model;
  readonly streamFn: StreamFn;
  readonly systemPrompt?: string;
  readonly tools?: readonly AgentTool[];
  readonly messages?: readonly AgentMessage[];
  readonly transformContext?: AgentLoopConfig['transformContext'];
  readonly convertToLlm?: AgentLoopConfig['convertToLlm'];
  readonly shouldStopAfterTurn?: AgentLoopConfig['shouldStopAfterTurn'];
}

export interface ShouldStopAfterTurnContext {
  readonly message: AssistantMessage;
  readonly toolResults: readonly ToolResultMessage[];
  readonly context: AgentContext;
  readonly newMessages: readonly AgentMessage[];
}

export type StreamFn = (model: Model, context: Context, options?: Options) => ModelEventStream;

export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

export type AgentEventListener = AgentEventSink;

export interface AgentLoopConfig {
  readonly model: Model;
  readonly transformContext?: (
    messages: readonly AgentMessage[],
    signal?: AbortSignal,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  readonly convertToLlm?: (
    messages: readonly AgentMessage[],
  ) => readonly Message[] | Promise<readonly Message[]>;
  readonly getSteeringMessages?: (
    signal?: AbortSignal,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  readonly getFollowUpMessages?: (
    signal?: AbortSignal,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  readonly shouldStopAfterTurn?: (
    context: ShouldStopAfterTurnContext,
  ) => boolean | Promise<boolean>;
}

export type MessageUpdateModelEvent = Extract<
  ModelStreamEvent,
  {
    type: 'text.delta' | 'tool-call.delta' | 'tool-call.completed' | 'usage';
  }
>;

export type AgentEvent =
  // 整个 Agent Trace 生命周期
  | {
      readonly type: 'agent_start';
    }
  | {
      readonly type: 'agent_end';
      readonly messages: readonly AgentMessage[];
    }

  // 单个 Turn 生命周期
  | {
      readonly type: 'turn_start';
    }
  | {
      readonly type: 'turn_end';
      readonly message: AgentMessage;
      readonly toolResults: readonly ToolResultMessage[];
    }

  // 模型消息生命周期
  | {
      readonly type: 'message_start';
      readonly message?: AgentMessage;
    }
  | {
      readonly type: 'message_update';
      readonly event: MessageUpdateModelEvent;
    }
  | {
      readonly type: 'message_end';
      readonly message: AgentMessage;
    }

  // 工具执行生命周期
  | {
      readonly type: 'tool_execution_start';
      readonly toolCall: ModelToolCall;
    }
  | {
      readonly type: 'tool_execution_end';
      readonly toolCall: ModelToolCall;
      readonly result: ToolResultMessage;
    };
