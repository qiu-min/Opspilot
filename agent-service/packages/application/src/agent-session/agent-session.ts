import { messageSchema, type Message } from '@opspilot/model-gateway';
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentState,
} from '@opspilot/agent-runtime';

import {
  estimateSessionContextTokens,
  shouldCompact,
  type CompactionResult,
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

type AutoCompactionResult = 'skipped' | 'compacted' | 'aborted';

export type AgentSessionEvent =
  | AgentEvent
  | {
      readonly type: 'compaction_start';
      readonly reason: 'threshold';
    }
  | {
      readonly type: 'compaction_end';
      readonly reason: 'threshold';
      readonly result: CompactionResult | undefined;
      readonly aborted: boolean;
      readonly errorMessage?: string;
    };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/** 应用层的最小 Agent 生命周期包装器，负责将完成消息写入 Session。 */
export class AgentSession {
  public readonly agent: Agent;
  public readonly sessionManager: SessionManager;

  private readonly unsubscribeAgent: () => void;
  private readonly eventListeners = new Set<AgentSessionEventListener>();
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
    await this.maybeCompactBeforePrompt();
    this.assertNotDisposed();
    const messages = await this.agent.prompt(input);
    await this.maybeCompactAfterRun();
    return messages;
  }

  /** 请求停止当前 Agent Run。 */
  public abort(): void {
    this.agent.abort();
  }

  /** 请求停止当前 Application-level Compaction。 */
  public abortCompaction(): void {
    this.autoCompactionAbortController?.abort();
  }

  /** 等待 Agent 进入空闲状态。 */
  public waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  /** 代理 Agent Runtime 的事件订阅。 */
  public subscribe(listener: AgentSessionEventListener): () => void {
    this.assertNotDisposed();
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
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
    this.abortCompaction();
    this.disposed = true;
    this.unsubscribeAgent();
    this.eventListeners.clear();
  }

  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('AgentSession is disposed.');
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === 'message_end' && isStandardMessage(event.message)) {
      this.sessionManager.appendMessage(event.message);
    }

    this.emit(event);
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /** Performs best-effort compaction before the next prompt and refreshes Runtime history. */
  private async maybeCompactBeforePrompt(): Promise<AutoCompactionResult> {
    return await this.runAutoCompactionIfNeeded();
  }

  /** Performs best-effort post-run compaction after normal message persistence completes. */
  private async maybeCompactAfterRun(): Promise<void> {
    if (this.agent.state.errorInfo !== undefined) return;
    await this.runAutoCompactionIfNeeded();
  }

  /** Runs threshold compaction once and refreshes Runtime history after success. */
  private async runAutoCompactionIfNeeded(): Promise<AutoCompactionResult> {
    const compactionService = this.compactionService;
    const compactionSettings = this.compactionSettings;
    const state = this.agent.state;
    if (compactionService === undefined || compactionSettings === undefined) return 'skipped';
    if (state.model.contextWindow === undefined) return 'skipped';

    const estimate = estimateSessionContextTokens(this.sessionManager.getBranch());
    if (!shouldCompact(estimate.tokens, state.model.contextWindow, compactionSettings))
      return 'skipped';

    const controller = new AbortController();
    this.autoCompactionAbortController = controller;
    let compactionStarted = false;
    try {
      compactionStarted = true;
      this.emit({ type: 'compaction_start', reason: 'threshold' });

      const result = await compactionService.compact({
        entries: this.sessionManager.getBranch(),
        model: state.model,
        settings: compactionSettings,
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        this.emitCompactionEnd(compactionStarted, {
          result: undefined,
          aborted: true,
        });
        return 'aborted';
      }
      if (result === undefined) {
        this.emitCompactionEnd(compactionStarted, {
          result: undefined,
          aborted: false,
        });
        return 'skipped';
      }

      this.sessionManager.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
      );
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.replaceMessages(sessionContext.messages);
      this.emitCompactionEnd(compactionStarted, { result, aborted: false });
      return 'compacted';
    } catch (error: unknown) {
      // Auto compaction is best-effort maintenance. Non-abort failures do not mutate Session or Runtime history.
      if (controller.signal.aborted) {
        this.emitCompactionEnd(compactionStarted, {
          result: undefined,
          aborted: true,
        });
        return 'aborted';
      }

      this.emitCompactionEnd(compactionStarted, {
        result: undefined,
        aborted: false,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return 'skipped';
    } finally {
      if (this.autoCompactionAbortController === controller) {
        this.autoCompactionAbortController = undefined;
      }
    }
  }

  private emitCompactionEnd(
    started: boolean,
    event: Omit<Extract<AgentSessionEvent, { type: 'compaction_end' }>, 'type' | 'reason'>,
  ): void {
    if (!started) return;
    this.emit({ type: 'compaction_end', reason: 'threshold', ...event });
  }
}

function isStandardMessage(message: AgentMessage): message is Message {
  return messageSchema.safeParse(message).success;
}
