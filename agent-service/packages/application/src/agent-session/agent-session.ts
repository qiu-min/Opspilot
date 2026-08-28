import { messageSchema, type Message } from '@opspilot/model-gateway';
import type {
  Agent,
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  AgentState,
} from '@opspilot/agent-runtime';

import { SessionManager } from '../session/session-manager.js';

export interface AgentSessionConfig {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
}

/** 应用层的最小 Agent 生命周期包装器，负责将完成消息写入 Session。 */
export class AgentSession {
  public readonly agent: Agent;
  public readonly sessionManager: SessionManager;

  private readonly unsubscribeAgent: () => void;
  private disposed = false;

  /** 创建 AgentSession 并注册唯一的内部持久化监听器。 */
  public constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.unsubscribeAgent = this.agent.subscribe((event) => this.handleAgentEvent(event));
  }

  /** 将一条或多条用户消息交给 Agent Runtime 执行。 */
  public prompt(input: AgentMessage | readonly AgentMessage[]): Promise<readonly AgentMessage[]> {
    return this.agent.prompt(input);
  }

  /** 请求停止当前 Agent Run。 */
  public abort(): void {
    this.agent.abort();
  }

  /** 等待 Agent 进入空闲状态。 */
  public waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  /** 代理 Agent Runtime 的事件订阅。 */
  public subscribe(listener: AgentEventListener): () => void {
    return this.agent.subscribe(listener);
  }

  /** 返回 Agent 当前状态快照。 */
  public get state(): AgentState {
    return this.agent.state;
  }

  /** 取消内部持久化监听；重复调用不会产生副作用。 */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeAgent();
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type !== 'message_end' || !isStandardMessage(event.message)) return;
    this.sessionManager.appendMessage(event.message);
  }
}

function isStandardMessage(message: AgentMessage): message is Message {
  return messageSchema.safeParse(message).success;
}
