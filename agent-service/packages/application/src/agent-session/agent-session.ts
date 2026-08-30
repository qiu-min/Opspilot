import { messageSchema, type Message } from '@opspilot/model-gateway';
import type {
  Agent,
  AgentEvent,
  AgentEventListener,
  AgentMessage,
  AgentState,
} from '@opspilot/agent-runtime';

import {
  estimateSessionContextTokens,
  shouldCompact,
  type CompactionService,
  type CompactionSettings,
} from '../context/index.js';
import { SessionManager } from '../session/session-manager.js';

export interface AgentSessionConfig {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly compactionService?: CompactionService;
  readonly compactionSettings?: CompactionSettings;
}

/** 应用层的最小 Agent 生命周期包装器，负责将完成消息写入 Session。 */
export class AgentSession {
  public readonly agent: Agent;
  public readonly sessionManager: SessionManager;

  private readonly unsubscribeAgent: () => void;
  private readonly compactionService?: CompactionService;
  private readonly compactionSettings?: CompactionSettings;
  private autoCompactionAbortController?: AbortController;
  private disposed = false;

  /** 创建 AgentSession 并注册唯一的内部持久化监听器。 */
  public constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.compactionService = config.compactionService;
    this.compactionSettings = config.compactionSettings;
    this.unsubscribeAgent = this.agent.subscribe((event) => this.handleAgentEvent(event));
  }

  /** 将一条或多条用户消息交给 Agent Runtime 执行。 */
  public async prompt(
    input: AgentMessage | readonly AgentMessage[],
  ): Promise<readonly AgentMessage[]> {
    this.assertNotDisposed();
    const messages = await this.agent.prompt(input);
    await this.maybeCompactAfterRun();
    return messages;
  }

  /** 请求停止当前 Agent Run。 */
  public abort(): void {
    this.agent.abort();
    this.autoCompactionAbortController?.abort();
  }

  /** 等待 Agent 进入空闲状态。 */
  public waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  /** 代理 Agent Runtime 的事件订阅。 */
  public subscribe(listener: AgentEventListener): () => void {
    this.assertNotDisposed();
    return this.agent.subscribe(listener);
  }

  /** 返回 Agent 当前状态快照。 */
  public get state(): AgentState {
    return this.agent.state;
  }

  /** 取消内部持久化监听；重复调用不会产生副作用。 */
  public dispose(): void {
    if (this.disposed) return;
    if (this.agent.state.isRunning) {
      throw new Error('Cannot dispose AgentSession while Agent is running. Wait for idle first.');
    }
    this.autoCompactionAbortController?.abort();
    this.disposed = true;
    this.unsubscribeAgent();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('AgentSession is disposed.');
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type !== 'message_end' || !isStandardMessage(event.message)) return;
    this.sessionManager.appendMessage(event.message);
  }

  /** Performs best-effort post-run compaction after normal message persistence completes. */
  private async maybeCompactAfterRun(): Promise<void> {
    const compactionService = this.compactionService;
    const compactionSettings = this.compactionSettings;
    const state = this.agent.state;
    if (compactionService === undefined || compactionSettings === undefined) return;
    if (state.model.contextWindow === undefined) return;
    if (state.errorInfo !== undefined) return;

    const estimate = estimateSessionContextTokens(this.sessionManager.getBranch());
    if (!shouldCompact(estimate.tokens, state.model.contextWindow, compactionSettings)) return;

    const controller = new AbortController();
    this.autoCompactionAbortController = controller;
    try {
      const result = await compactionService.compact({
        entries: this.sessionManager.getBranch(),
        model: state.model,
        settings: compactionSettings,
        signal: controller.signal,
      });
      if (result !== undefined && !controller.signal.aborted) {
        this.sessionManager.appendCompaction(
          result.summary,
          result.firstKeptEntryId,
          result.tokensBefore,
        );
      }
    } catch {
      // Compaction is post-run maintenance; the completed user turn remains successful.
    } finally {
      if (this.autoCompactionAbortController === controller) {
        this.autoCompactionAbortController = undefined;
      }
    }
  }
}

function isStandardMessage(message: AgentMessage): message is Message {
  return messageSchema.safeParse(message).success;
}
