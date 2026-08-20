import { runAgentLoop } from './agent-loop.js';
import type {
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  AgentOptions,
  AgentState,
  AgentTool,
} from './types.js';

/**
 * 有状态的 Agent 包装器，负责保存会话历史并调用底层 Agent Loop。
 */
export class Agent {
  private readonly model: AgentOptions['model'];
  private readonly streamFn: AgentOptions['streamFn'];
  private readonly systemPrompt: AgentOptions['systemPrompt'];
  private readonly tools: readonly AgentTool[];
  private readonly transformContext: AgentOptions['transformContext'];
  private readonly convertToLlm: AgentOptions['convertToLlm'];
  private readonly shouldStopAfterTurn: AgentOptions['shouldStopAfterTurn'];
  private readonly messages: AgentMessage[];
  private readonly listeners = new Set<AgentEventListener>();
  private isRunning = false;
  private abortController?: AbortController;

  /** 创建一个保存自身消息历史的 Agent。
   * @param options Agent 模型、流函数、初始上下文和 Loop hooks。
   */
  constructor(options: AgentOptions) {
    this.model = options.model;
    this.streamFn = options.streamFn;
    this.systemPrompt = options.systemPrompt;
    this.tools = [...(options.tools ?? [])];
    this.transformContext = options.transformContext;
    this.convertToLlm = options.convertToLlm;
    this.shouldStopAfterTurn = options.shouldStopAfterTurn;
    this.messages = [...(options.messages ?? [])];
  }

  /** 返回 Agent 状态的浅快照，避免调用方修改内部数组。
   * @returns 当前模型、配置、消息历史和运行状态。
   */
  get state(): AgentState {
    return {
      systemPrompt: this.systemPrompt,
      model: this.model,
      tools: [...this.tools],
      messages: [...this.messages],
      isRunning: this.isRunning,
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
    if (this.isRunning) throw new Error('Agent is already running.');

    const prompts = Array.isArray(input) ? [...input] : [input];
    const controller = new AbortController();
    this.abortController = controller;
    this.isRunning = true;

    try {
      const context = {
        systemPrompt: this.systemPrompt,
        messages: [...this.messages],
        tools: [...this.tools],
      };
      const newMessages = await runAgentLoop(
        prompts,
        context,
        {
          model: this.model,
          transformContext: this.transformContext,
          convertToLlm: this.convertToLlm,
          shouldStopAfterTurn: this.shouldStopAfterTurn,
        },
        this.streamFn,
        async (event) => {
          await this.emit(event);
        },
        controller.signal,
      );

      this.messages.push(...newMessages);
      return newMessages;
    } finally {
      this.isRunning = false;
      this.abortController = undefined;
    }
  }

  /** 请求当前模型或工具调用通过已有 AbortSignal 结束。
   */
  abort(): void {
    this.abortController?.abort();
  }

  /** 清空 Agent 会话历史；运行中不能重置。
   */
  reset(): void {
    if (this.isRunning) throw new Error('Cannot reset while Agent is running.');
    this.messages.length = 0;
  }

  /** 按订阅顺序等待所有监听器处理一个事件。
   * @param event 要转发的 AgentEvent。
   */
  private async emit(event: AgentEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}
