import {
  runAgentLoopWithOutcome,
  type AgentLoopTermination,
  type AgentLoopOutcome,
} from './agent-loop.js';
import type { AssistantMessage, ModelToolCall } from '@opspilot/model-gateway';
import type {
  AgentEvent,
  AgentEventListener,
  AgentErrorInfo,
  AgentLoopConfig,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
} from './types.js';

/** 标记事件监听器异常，避免它被误判为 Agent Runtime fatal error。
 * @param cause 原始监听器异常。
 */
class AgentEventListenerError extends Error {
  /** 保存原始监听器异常，供生命周期边界原样抛出。
   * @param cause 原始监听器异常。
   */
  constructor(readonly cause: unknown) {
    super('Agent event listener failed.');
    this.name = 'AgentEventListenerError';
  }
}

type MutableAgentState = {
  systemPrompt?: string;
  model: AgentOptions['model'];
  thinkingLevel: NonNullable<AgentOptions['thinkingLevel']>;
  tools: AgentTool[];
  messages: AgentMessage[];
  isRunning: boolean;
  streamingMessage?: AgentMessage;
  errorMessage?: string;
  errorInfo?: AgentErrorInfo;
  pendingToolCalls: ModelToolCall[];
};

type ActiveRun = {
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  currentModel: AgentOptions['model'];
};

/**
 * 有状态的 Agent 包装器，负责保存会话历史并调用底层 Agent Loop。
 */
export class Agent {
  private readonly streamFn: AgentOptions['streamFn'];
  private readonly transformContext: AgentOptions['transformContext'];
  private readonly convertToLlm: AgentOptions['convertToLlm'];
  private readonly prepareNextTurn: AgentOptions['prepareNextTurn'];
  private readonly shouldStopAfterTurn: AgentOptions['shouldStopAfterTurn'];
  private readonly beforeToolCall: AgentOptions['beforeToolCall'];
  private readonly afterToolCall: AgentOptions['afterToolCall'];
  private readonly toolExecution: AgentOptions['toolExecution'];
  private readonly _state: MutableAgentState;
  private readonly steeringQueue: AgentMessage[] = [];
  private readonly followUpQueue: AgentMessage[] = [];
  private readonly listeners = new Set<AgentEventListener>();
  private activeRun?: ActiveRun;

  /** 创建一个保存自身消息历史的 Agent。
   * @param options Agent 模型、流函数、初始上下文和 Loop hooks。
   */
  constructor(options: AgentOptions) {
    this.streamFn = options.streamFn;
    this.transformContext = options.transformContext;
    this.convertToLlm = options.convertToLlm;
    this.prepareNextTurn = options.prepareNextTurn;
    this.shouldStopAfterTurn = options.shouldStopAfterTurn;
    this.beforeToolCall = options.beforeToolCall;
    this.afterToolCall = options.afterToolCall;
    this.toolExecution = options.toolExecution;
    this._state = {
      systemPrompt: options.systemPrompt,
      model: options.model,
      thinkingLevel: options.thinkingLevel ?? 'off',
      tools: [...(options.tools ?? [])],
      messages: [...(options.messages ?? [])],
      isRunning: false,
      streamingMessage: undefined,
      errorMessage: undefined,
      errorInfo: undefined,
      pendingToolCalls: [],
    };
  }

  /** 返回 Agent 状态的浅快照，避免调用方修改内部数组。
   * @returns 当前模型、配置、消息历史和运行状态。
   */
  get state(): AgentState {
    return {
      systemPrompt: this._state.systemPrompt,
      model: this._state.model,
      thinkingLevel: this._state.thinkingLevel,
      tools: [...this._state.tools],
      messages: [...this._state.messages],
      isRunning: this._state.isRunning,
      streamingMessage: this._state.streamingMessage,
      errorMessage: this._state.errorMessage,
      errorInfo: this._state.errorInfo === undefined ? undefined : { ...this._state.errorInfo },
      pendingToolCalls: [...this._state.pendingToolCalls],
    };
  }

  /** 注册一个按顺序接收 AgentEvent 的监听器。
   * @param listener 要注册的事件监听器。
   * @returns 取消该监听器订阅的函数。
   */
  subscribe(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 执行一次 Agent Run。
   * @param input 本次运行新增的一条或多条 AgentMessage。
   * @returns 本次运行新增的完整消息列表。
   */
  async prompt(input: AgentMessage | readonly AgentMessage[]): Promise<readonly AgentMessage[]> {
    const prompts = Array.isArray(input) ? [...input] : [input];
    return await this.runPromptMessages(prompts);
  }

  /** 请求当前模型或工具调用通过已有 AbortSignal 结束。
   */
  abort(): void {
    this.activeRun?.abortController.abort();
  }

  /** 返回当前运行的取消信号；空闲时没有活动信号。
   * @returns 当前 ActiveRun 的 AbortSignal，或 undefined。
   */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** 等待当前运行完成并完成生命周期清理；空闲时立即完成。
   * @returns 在 Agent 进入空闲状态后完成的 Promise。
   */
  async waitForIdle(): Promise<void> {
    await (this.activeRun?.promise ?? Promise.resolve());
  }

  /** 将一条或多条消息按原顺序加入 steering 队列。
   * @param message 要尽快影响当前任务后续执行的消息或消息列表。
   */
  steer(message: AgentMessage | readonly AgentMessage[]): void {
    const messages = Array.isArray(message) ? message : [message];
    this.steeringQueue.push(...messages);
  }

  /** 将一条或多条消息按原顺序加入 follow-up 队列。
   * @param message 要在当前工作自然结束后继续处理的消息或消息列表。
   */
  followUp(message: AgentMessage | readonly AgentMessage[]): void {
    const messages = Array.isArray(message) ? message : [message];
    this.followUpQueue.push(...messages);
  }

  /** 清空 steering 队列中的所有消息。 */
  clearSteeringQueue(): void {
    this.steeringQueue.length = 0;
  }

  /** 清空 follow-up 队列中的所有消息。 */
  clearFollowUpQueue(): void {
    this.followUpQueue.length = 0;
  }

  /** 同时清空 steering 和 follow-up 队列。 */
  clearAllQueues(): void {
    this.clearSteeringQueue();
    this.clearFollowUpQueue();
  }

  /** 判断两个队列中是否至少有一条等待处理的消息。
   * @returns 任一队列非空时返回 true，否则返回 false。
   */
  hasQueuedMessages(): boolean {
    return this.steeringQueue.length > 0 || this.followUpQueue.length > 0;
  }

  /** 清空 Agent 会话历史；运行中不能重置。
   */
  reset(): void {
    if (this.activeRun) throw new Error('Cannot reset while Agent is running.');
    this._state.messages.length = 0;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;
    this._state.errorInfo = undefined;
    this._state.pendingToolCalls.length = 0;
    this.clearAllQueues();
  }

  /** 取出并清空当前 steering 队列，返回独立数组避免暴露内部存储。
   * @returns 当前队列中的全部消息，保持入队顺序。
   */
  private drainSteeringQueue(): AgentMessage[] {
    const messages = [...this.steeringQueue];
    this.steeringQueue.length = 0;
    return messages;
  }

  /** 取出并清空当前 follow-up 队列，返回独立数组避免暴露内部存储。
   * @returns 当前队列中的全部消息，保持入队顺序。
   */
  private drainFollowUpQueue(): AgentMessage[] {
    const messages = [...this.followUpQueue];
    this.followUpQueue.length = 0;
    return messages;
  }

  /** 创建一次运行使用的 Loop 配置，并连接两个消息队列的消费回调。
   * @returns 包含模型、现有 hooks 和队列 drain callback 的 Loop 配置。
   */
  private createLoopConfig(): AgentLoopConfig {
    const prepareNextTurn = this.prepareNextTurn;

    return {
      model: this._state.model,
      thinkingLevel: this._state.thinkingLevel,
      transformContext: this.transformContext,
      convertToLlm: this.convertToLlm,
      prepareNextTurn:
        prepareNextTurn === undefined
          ? undefined
          : async (context, signal) => {
              const update = await prepareNextTurn(context, signal);
              if (update?.model !== undefined && this.activeRun !== undefined) {
                this.activeRun.currentModel = update.model;
              }
              return update;
            },
      getSteeringMessages: () => this.drainSteeringQueue(),
      getFollowUpMessages: () => this.drainFollowUpQueue(),
      shouldStopAfterTurn: this.shouldStopAfterTurn,
      beforeToolCall: this.beforeToolCall,
      afterToolCall: this.afterToolCall,
      toolExecution: this.toolExecution,
    };
  }

  /** 启动一次 prompt run，并返回本次新增消息。
   * @param prompts 已归一化的本次运行消息列表。
   * @returns 本次运行新增的完整消息列表。
   */
  private async runPromptMessages(
    prompts: readonly AgentMessage[],
  ): Promise<readonly AgentMessage[]> {
    const runStartMessageIndex = this._state.messages.length;
    return await this.runWithLifecycle(async (signal) => {
      const context = {
        systemPrompt: this._state.systemPrompt,
        messages: [...this._state.messages],
        tools: [...this._state.tools],
      };
      const outcome = await runAgentLoopWithOutcome(
        prompts,
        context,
        this.createLoopConfig(),
        this.streamFn,
        async (event) => {
          await this.processEvents(event);
        },
        signal,
      );

      return outcome;
    }, runStartMessageIndex);
  }

  /** 承担一次 Agent Run 的并发、取消、状态和清理边界。
   * @param executor 接收本次运行 AbortSignal 并执行具体工作的函数。
   * @param runStartMessageIndex 本次运行开始前的消息数量，用于保留已完成消息。
   * @returns executor 成功结果，或包含 runtime failure 消息的本次运行消息。
   */
  private async runWithLifecycle(
    executor: (signal: AbortSignal) => Promise<AgentLoopOutcome>,
    runStartMessageIndex: number,
  ): Promise<readonly AgentMessage[]> {
    if (this.activeRun) throw new Error('Agent is already running.');

    const abortController = new AbortController();
    let resolveRun!: () => void;
    const promise = new Promise<void>((resolve) => {
      resolveRun = resolve;
    });
    const activeRun: ActiveRun = {
      abortController,
      promise,
      resolve: resolveRun,
      currentModel: this._state.model,
    };

    this.activeRun = activeRun;
    this._state.isRunning = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;
    this._state.errorInfo = undefined;
    this._state.pendingToolCalls.length = 0;

    try {
      const outcome = await executor(abortController.signal);
      if (outcome.termination !== undefined) {
        return await this.handleRunTermination(outcome.termination, runStartMessageIndex);
      }
      return outcome.messages;
    } catch (error: unknown) {
      if (error instanceof AgentEventListenerError) throw error.cause;
      return await this.handleRunFailure(error, abortController, runStartMessageIndex);
    } finally {
      this._state.isRunning = false;
      this._state.streamingMessage = undefined;
      this._state.pendingToolCalls.length = 0;
      this.activeRun = undefined;
      activeRun.resolve();
    }
  }

  /** 将工具批次的显式终止结果转成完整生命周期中的 synthetic assistant 消息。 */
  private async handleRunTermination(
    termination: AgentLoopTermination,
    runStartMessageIndex: number,
  ): Promise<readonly AgentMessage[]> {
    const model = this.activeRun?.currentModel ?? this._state.model;
    const failureMessage: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      finishReason: termination.reason,
      errorMessage: termination.message,
    };

    this._state.errorMessage = termination.message;
    this._state.errorInfo = {
      source: 'runtime',
      reason: termination.reason,
      message: termination.message,
    };

    await this.processEvents({ type: 'message_start', message: failureMessage });
    await this.processEvents({ type: 'message_end', message: failureMessage });

    const runMessages = this._state.messages.slice(runStartMessageIndex);
    await this.processEvents({
      type: 'turn_end',
      message: failureMessage,
      toolResults: [...termination.toolResults],
    });
    await this.processEvents({ type: 'agent_end', messages: runMessages });
    return runMessages;
  }

  /** 将未预期的 Runtime 异常转成完整生命周期中的 synthetic assistant 消息。
   * @param error 从 Agent Loop 或 Runtime hook 冒出的未知异常。
   * @param abortController 本次运行的取消控制器，用于判断失败是否由 abort 导致。
   * @param runStartMessageIndex 本次运行开始前的消息数量。
   * @returns 本次运行已经提交的全部消息。
   */
  private async handleRunFailure(
    error: unknown,
    abortController: AbortController,
    runStartMessageIndex: number,
  ): Promise<readonly AgentMessage[]> {
    const message = error instanceof Error ? error.message : String(error);
    const aborted = abortController.signal.aborted;
    const reason = aborted ? 'aborted' : 'error';
    const model = this.activeRun?.currentModel ?? this._state.model;
    // 该消息由 Agent Runtime 在未预期运行异常时人工生成，用来保持 transcript 和 Agent 生命周期完整；它不是 Provider 返回的模型消息。
    const failureMessage: AssistantMessage = {
      role: 'assistant',
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [],
      finishReason: reason,
      errorMessage: message,
    };

    this._state.errorMessage = message;
    this._state.errorInfo = {
      source: 'runtime',
      reason,
      message,
    };

    await this.processEvents({ type: 'message_start', message: failureMessage });
    await this.processEvents({ type: 'message_end', message: failureMessage });

    const runMessages = this._state.messages.slice(runStartMessageIndex);
    await this.processEvents({
      type: 'turn_end',
      message: failureMessage,
      toolResults: [],
    });
    await this.processEvents({ type: 'agent_end', messages: runMessages });
    return runMessages;
  }

  /** 先更新实时状态，再按订阅顺序等待所有监听器处理一个事件。
   * @param event 要转发的 AgentEvent。
   */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case 'agent_start':
        this._state.isRunning = true;
        break;
      case 'message_start':
        this._state.streamingMessage = event.message;
        break;
      case 'message_update':
        this._state.streamingMessage = event.message;
        break;
      case 'message_end':
        this._state.streamingMessage = undefined;
        this._state.messages.push(event.message);
        break;
      case 'tool_execution_start':
        if (
          !this._state.pendingToolCalls.some(
            (toolCall) => toolCall.callId === event.toolCall.callId,
          )
        ) {
          this._state.pendingToolCalls.push(event.toolCall);
        }
        break;
      case 'tool_execution_end':
        this._state.pendingToolCalls = this._state.pendingToolCalls.filter(
          (toolCall) => toolCall.callId !== event.toolCall.callId,
        );
        break;
      case 'agent_end':
        this._state.streamingMessage = undefined;
        this._state.pendingToolCalls.length = 0;
        break;
      case 'turn_start':
        break;
      case 'turn_end':
        if (
          event.message.role === 'assistant' &&
          (event.message.finishReason === 'error' || event.message.finishReason === 'aborted') &&
          event.message.errorMessage !== undefined
        ) {
          this._state.errorMessage = event.message.errorMessage;
          if (this._state.errorInfo === undefined) {
            this._state.errorInfo = {
              source: 'model',
              reason: event.message.finishReason,
              message: event.message.errorMessage,
            };
          }
        }
        break;
    }

    try {
      for (const listener of this.listeners) {
        await listener(event);
      }
    } catch (error: unknown) {
      throw new AgentEventListenerError(error);
    }
  }
}
