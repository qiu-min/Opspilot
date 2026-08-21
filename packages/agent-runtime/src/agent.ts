import { runAgentLoop } from './agent-loop.js';
import type { ModelToolCall } from '@opspilot/model-gateway';
import type {
  AgentEvent,
  AgentEventListener,
  AgentLoopConfig,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
} from './types.js';

type MutableAgentState = {
  systemPrompt?: string;
  model: AgentOptions['model'];
  tools: AgentTool[];
  messages: AgentMessage[];
  isRunning: boolean;
  streamingText?: string;
  pendingToolCalls: ModelToolCall[];
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
  private readonly _state: MutableAgentState;
  private readonly steeringQueue: AgentMessage[] = [];
  private readonly followUpQueue: AgentMessage[] = [];
  private readonly listeners = new Set<AgentEventListener>();
  private abortController?: AbortController;

  /** 创建一个保存自身消息历史的 Agent。
   * @param options Agent 模型、流函数、初始上下文和 Loop hooks。
   */
  constructor(options: AgentOptions) {
    this.streamFn = options.streamFn;
    this.transformContext = options.transformContext;
    this.convertToLlm = options.convertToLlm;
    this.prepareNextTurn = options.prepareNextTurn;
    this.shouldStopAfterTurn = options.shouldStopAfterTurn;
    this._state = {
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: [...(options.tools ?? [])],
      messages: [...(options.messages ?? [])],
      isRunning: false,
      streamingText: undefined,
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
      tools: [...this._state.tools],
      messages: [...this._state.messages],
      isRunning: this._state.isRunning,
      streamingText: this._state.streamingText,
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

  /** 执行一次 Agent Run，并在成功后提交本次新增消息。
   * @param input 本次运行新增的一条或多条 AgentMessage。
   * @returns 本次运行新增的完整消息列表。
   */
  async prompt(input: AgentMessage | readonly AgentMessage[]): Promise<readonly AgentMessage[]> {
    if (this._state.isRunning) throw new Error('Agent is already running.');

    const prompts = Array.isArray(input) ? [...input] : [input];
    const controller = new AbortController();
    this.abortController = controller;
    this._state.isRunning = true;

    try {
      const context = {
        systemPrompt: this._state.systemPrompt,
        messages: [...this._state.messages],
        tools: [...this._state.tools],
      };
      const newMessages = await runAgentLoop(
        prompts,
        context,
        this.createLoopConfig(),
        this.streamFn,
        async (event) => {
          await this.processEvents(event);
        },
        controller.signal,
      );

      this._state.messages.push(...newMessages);
      return newMessages;
    } finally {
      this._state.isRunning = false;
      this._state.streamingText = undefined;
      this._state.pendingToolCalls.length = 0;
      this.abortController = undefined;
    }
  }

  /** 请求当前模型或工具调用通过已有 AbortSignal 结束。
   */
  abort(): void {
    this.abortController?.abort();
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
    if (this._state.isRunning) throw new Error('Cannot reset while Agent is running.');
    this._state.messages.length = 0;
    this._state.streamingText = undefined;
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
    return {
      model: this._state.model,
      transformContext: this.transformContext,
      convertToLlm: this.convertToLlm,
      prepareNextTurn: this.prepareNextTurn,
      getSteeringMessages: () => this.drainSteeringQueue(),
      getFollowUpMessages: () => this.drainFollowUpQueue(),
      shouldStopAfterTurn: this.shouldStopAfterTurn,
    };
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
        if (event.message === undefined) this._state.streamingText = '';
        break;
      case 'message_update':
        if (event.event.type === 'text.delta') {
          this._state.streamingText = `${this._state.streamingText ?? ''}${event.event.delta}`;
        }
        break;
      case 'message_end':
        if (event.message.role === 'assistant') this._state.streamingText = undefined;
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
        this._state.streamingText = undefined;
        this._state.pendingToolCalls.length = 0;
        break;
      case 'turn_start':
      case 'turn_end':
        break;
    }

    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
