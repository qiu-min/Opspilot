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

export interface AgentToolResult<TDetails = unknown> {
  readonly content: readonly TextContent[];
  readonly details?: TDetails;
}

export interface AgentTool<TDetails = unknown> extends Tool {
  execute(
    callId: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<TDetails>>;
}

export type ToolExecutionMode = 'sequential' | 'parallel';

/** 预留给业务包通过 declaration merging 扩展 Agent 消息。 */
export interface CustomAgentMessages {}

/** Agent Runtime 内部流转的标准消息或业务扩展消息。 */
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];

export interface AgentContext {
  readonly systemPrompt?: string;
  messages: AgentMessage[];
  readonly tools?: readonly AgentTool[];
}

/** beforeToolCall 收到的已完成模型消息、已校验参数和当前 Agent 上下文。 */
export interface BeforeToolCallContext {
  readonly assistantMessage: AssistantMessage;
  readonly toolCall: ModelToolCall;
  readonly args: JsonObject;
  readonly context: AgentContext;
}

/** beforeToolCall 对当前 ToolCall 的最小拦截决策。 */
export interface BeforeToolCallResult {
  readonly block?: boolean;
  readonly reason?: string;
}

/** afterToolCall 收到的执行结果和当前 ToolCall 上下文。 */
export interface AfterToolCallContext<TDetails = unknown> {
  readonly assistantMessage: AssistantMessage;
  readonly toolCall: ModelToolCall;
  readonly args: JsonObject;
  readonly result: AgentToolResult<TDetails>;
  readonly isError: boolean;
  readonly context: AgentContext;
}

/** afterToolCall 对 Tool 内容和错误状态的最终覆盖。 */
export interface AfterToolCallResult<TDetails = unknown> {
  readonly content?: readonly TextContent[];
  readonly details?: TDetails;
  readonly isError?: boolean;
}

export type AgentErrorSource = 'model' | 'runtime';

/** Agent Runtime 层的诊断 metadata，不进入 model-gateway AssistantMessage contract。 */
export interface AgentErrorInfo {
  readonly source: AgentErrorSource;
  readonly reason: 'error' | 'aborted';
  readonly message: string;
}

export interface AgentState {
  readonly systemPrompt?: string;
  readonly model: Model;
  readonly tools: readonly AgentTool[];
  readonly messages: readonly AgentMessage[];
  readonly isRunning: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly errorMessage?: string;
  readonly errorInfo?: AgentErrorInfo;
  readonly pendingToolCalls: readonly ModelToolCall[];
}

export interface AgentOptions {
  readonly model: Model;
  readonly streamFn: StreamFn;
  readonly systemPrompt?: string;
  readonly tools?: readonly AgentTool[];
  readonly messages?: readonly AgentMessage[];
  readonly transformContext?: AgentLoopConfig['transformContext'];
  readonly convertToLlm?: AgentLoopConfig['convertToLlm'];
  readonly prepareNextTurn?: AgentLoopConfig['prepareNextTurn'];
  readonly shouldStopAfterTurn?: AgentLoopConfig['shouldStopAfterTurn'];
  readonly beforeToolCall?: AgentLoopConfig['beforeToolCall'];
  readonly afterToolCall?: AgentLoopConfig['afterToolCall'];
  readonly toolExecution?: ToolExecutionMode;
}

export interface ShouldStopAfterTurnContext {
  readonly message: AssistantMessage;
  readonly toolResults: readonly ToolResultMessage[];
  readonly context: AgentContext;
  readonly newMessages: readonly AgentMessage[];
}

export interface PrepareNextTurnContext {
  readonly message: AssistantMessage;
  readonly toolResults: readonly ToolResultMessage[];
  readonly context: AgentContext;
  readonly newMessages: readonly AgentMessage[];
}

export interface AgentLoopTurnUpdate {
  readonly context?: AgentContext;
  readonly model?: Model;
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
  readonly prepareNextTurn?: (
    context: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => AgentLoopTurnUpdate | undefined | Promise<AgentLoopTurnUpdate | undefined>;
  readonly getSteeringMessages?: (
    signal?: AbortSignal,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  readonly getFollowUpMessages?: (
    signal?: AbortSignal,
  ) => readonly AgentMessage[] | Promise<readonly AgentMessage[]>;
  readonly shouldStopAfterTurn?: (
    context: ShouldStopAfterTurnContext,
  ) => boolean | Promise<boolean>;
  readonly beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => BeforeToolCallResult | undefined | Promise<BeforeToolCallResult | undefined>;
  readonly afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => AfterToolCallResult | undefined | Promise<AfterToolCallResult | undefined>;
  readonly toolExecution?: ToolExecutionMode;
}

export type MessageUpdateModelEvent = Extract<
  ModelStreamEvent,
  {
    type: 'text.delta' | 'thinking.delta' | 'tool-call.delta' | 'tool-call.completed' | 'usage';
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
      readonly message: AgentMessage;
    }
  | {
      readonly type: 'message_update';
      readonly event: MessageUpdateModelEvent;
      readonly message: AssistantMessage;
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
