import {
  isContextOverflow,
  messageSchema,
  type AssistantMessage,
  type Message,
} from '@opspilot/model-gateway';
import type { Agent, AgentEvent, AgentMessage, AgentState } from '@opspilot/agent-runtime';

import {
  estimateSessionContextTokens,
  prepareCompaction,
  shouldCompact,
  type CompactionPreparation,
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

export type AgentSessionEvent =
  | AgentEvent
  | {
      readonly type: 'compaction_start';
      readonly reason: CompactionReason;
    }
  | {
      readonly type: 'compaction_end';
      readonly reason: CompactionReason;
      readonly result: CompactionResult | undefined;
      readonly aborted: boolean;
      readonly willRetry: boolean;
      readonly errorMessage?: string;
    };

export type CompactionReason = 'threshold' | 'overflow';

export type AgentSessionEventListener = (event: AgentSessionEvent) => void | Promise<void>;

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
  private promptActive = false;
  private overflowRecoveryAttempted = false;

  /** 创建 AgentSession 并注册唯一的内部持久化监听器。 */
  public constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.compactionService = config.compactionService;
    this.compactionSettings = config.compactionSettings;
    this.unsubscribeAgent = this.agent.subscribe(
      async (event) => await this.handleAgentEvent(event),
    );
  }

  /** 将一条或多条用户消息交给 Agent Runtime 执行；同一 Session 不允许重叠 prompt operation。 */
  public async prompt(
    input: AgentMessage | readonly AgentMessage[],
  ): Promise<readonly AgentMessage[]> {
    this.assertNotDisposed();
    if (this.promptActive) {
      throw new Error('AgentSession is already processing a prompt.');
    }

    this.promptActive = true;
    this.overflowRecoveryAttempted = false;
    try {
      await this.maybeCompactBeforePrompt();
      this.assertNotDisposed();
      const messages = [...(await this.agent.prompt(input))];
      while (await this.handlePostAgentRun()) {
        messages.push(...(await this.agent.continue()));
      }
      return messages;
    } finally {
      this.overflowRecoveryAttempted = false;
      this.promptActive = false;
    }
  }

  /** 请求停止当前 Agent Run。 */
  public abort(): void {
    this.agent.abort();
  }

  /** 请求停止当前 Application-level Compaction。 */
  public abortCompaction(): void {
    this.autoCompactionAbortController?.abort();
  }

  /** 等待 Agent Runtime 进入空闲状态；这不代表整个 Session prompt operation 已 settled。 */
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

  private async handleAgentEvent(event: AgentEvent): Promise<void> {
    if (event.type === 'message_end' && isStandardMessage(event.message)) {
      this.sessionManager.appendMessage(event.message);
    }

    await this.emit(event);
  }

  private async emit(event: AgentSessionEvent): Promise<void> {
    for (const listener of this.eventListeners) {
      await listener(event);
    }
  }

  /** Performs best-effort compaction before the next prompt and refreshes Runtime history. */
  private async maybeCompactBeforePrompt(): Promise<void> {
    await this.runAutoCompactionIfNeeded();
  }

  /** Performs best-effort post-run compaction after normal message persistence completes. */
  private async maybeCompactAfterRun(): Promise<void> {
    if (this.agent.state.errorInfo !== undefined) return;
    await this.runAutoCompactionIfNeeded();
  }

  /** Handles the post-run recovery decision before considering threshold maintenance. */
  private async handlePostAgentRun(): Promise<boolean> {
    const lastAssistant = this.findLastAssistantMessage();
    if (lastAssistant !== undefined && this.isCurrentModelAssistant(lastAssistant)) {
      if (isContextOverflow(lastAssistant, this.agent.state.model.contextWindow)) {
        return await this.maybeRecoverContextOverflow(lastAssistant);
      }
    }

    await this.maybeCompactAfterRun();
    return false;
  }

  /** Finds the most recent standard assistant message in the Runtime working history. */
  private findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message !== undefined && isStandardMessage(message) && message.role === 'assistant') {
        return message;
      }
    }
    return undefined;
  }

  /** Avoids recovering an error produced by a model that is no longer active. */
  private isCurrentModelAssistant(message: AssistantMessage): boolean {
    const model = this.agent.state.model;
    return message.provider === model.provider && message.model === model.id;
  }

  /** Performs one bounded overflow recovery attempt and returns whether Runtime should continue. */
  private async maybeRecoverContextOverflow(target: AssistantMessage): Promise<boolean> {
    if (this.overflowRecoveryAttempted) return false;
    this.overflowRecoveryAttempted = true;

    const willRetry = target.finishReason !== 'stop';

    const compactionService = this.compactionService;
    const compactionSettings = this.compactionSettings;
    if (compactionService === undefined || compactionSettings === undefined) return false;

    const preparation = prepareCompaction(this.sessionManager.getBranch(), compactionSettings);
    if (preparation === undefined) return false;

    return await this.runCompaction(
      'overflow',
      preparation,
      willRetry,
      willRetry ? target : undefined,
    );
  }

  /** Removes only the exact recoverable assistant at the Runtime history tail. */
  private removeRecoverableAssistantFromRuntime(target: AssistantMessage): void {
    const messages = this.agent.state.messages;
    const lastMessage = messages.at(-1);
    if (
      lastMessage === undefined ||
      !isStandardMessage(lastMessage) ||
      lastMessage.role !== 'assistant' ||
      !sameAssistantMessage(lastMessage, target)
    ) {
      return;
    }

    this.agent.replaceMessages(messages.slice(0, -1));
  }

  /** Runs threshold or overflow compaction and refreshes Runtime history after success. */
  private async runAutoCompactionIfNeeded(): Promise<void> {
    const compactionService = this.compactionService;
    const compactionSettings = this.compactionSettings;
    const state = this.agent.state;
    if (compactionService === undefined || compactionSettings === undefined) return;
    if (state.model.contextWindow === undefined) return;

    const entries = this.sessionManager.getBranch();
    const estimate = estimateSessionContextTokens(entries);
    if (!shouldCompact(estimate.tokens, state.model.contextWindow, compactionSettings)) return;

    const preparation = prepareCompaction(entries, compactionSettings);
    if (preparation === undefined) return;

    await this.runCompaction('threshold', preparation, false);
  }

  /** Executes the shared summary, persistence, projection rebuild, and event lifecycle. */
  private async runCompaction(
    reason: CompactionReason,
    preparation: CompactionPreparation,
    willRetry: boolean,
    retryTarget?: AssistantMessage,
  ): Promise<boolean> {
    const compactionService = this.compactionService;
    const state = this.agent.state;
    if (compactionService === undefined) return false;

    const controller = new AbortController();
    this.autoCompactionAbortController = controller;
    try {
      // Event dispatch is deliberately outside the operation catch below. A listener
      // failure is an observer failure, not a compaction failure.
      await this.emit({ type: 'compaction_start', reason });

      let operationOutcome:
        | { readonly kind: 'success'; readonly result: CompactionResult }
        | { readonly kind: 'failure'; readonly error: unknown };
      try {
        const summaryResult = await compactionService.compact({
          messages: preparation.messagesToSummarize,
          model: state.model,
          signal: controller.signal,
        });
        const result: CompactionResult = {
          summary: summaryResult.summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
        };
        if (!controller.signal.aborted) {
          this.sessionManager.appendCompaction(
            result.summary,
            result.firstKeptEntryId,
            result.tokensBefore,
          );
          const sessionContext = this.sessionManager.buildSessionContext();
          this.agent.replaceMessages(sessionContext.messages);
          if (willRetry && retryTarget !== undefined) {
            this.removeRecoverableAssistantFromRuntime(retryTarget);
          }
        }
        operationOutcome = { kind: 'success', result };
      } catch (error: unknown) {
        operationOutcome = { kind: 'failure', error };
      }

      if (controller.signal.aborted) {
        await this.emitCompactionEnd(reason, {
          result: undefined,
          aborted: true,
          willRetry: false,
        });
        return false;
      }

      if (operationOutcome.kind === 'failure') {
        await this.emitCompactionEnd(reason, {
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage:
            operationOutcome.error instanceof Error
              ? operationOutcome.error.message
              : String(operationOutcome.error),
        });
        return false;
      }

      await this.emitCompactionEnd(reason, {
        result: operationOutcome.result,
        aborted: false,
        willRetry,
      });
      return willRetry && !this.disposed && !controller.signal.aborted;
    } finally {
      if (this.autoCompactionAbortController === controller) {
        this.autoCompactionAbortController = undefined;
      }
    }
  }

  private emitCompactionEnd(
    reason: CompactionReason,
    event: Omit<Extract<AgentSessionEvent, { type: 'compaction_end' }>, 'type' | 'reason'>,
  ): Promise<void> {
    return this.emit({ type: 'compaction_end', reason, ...event });
  }
}

function isStandardMessage(message: AgentMessage): message is Message {
  return messageSchema.safeParse(message).success;
}

/** Compares the stable identity fields used to remove a rebuilt overflow response. */
function sameAssistantMessage(left: AssistantMessage, right: AssistantMessage): boolean {
  return (
    left === right ||
    (left.api === right.api &&
      left.provider === right.provider &&
      left.model === right.model &&
      left.finishReason === right.finishReason &&
      left.errorMessage === right.errorMessage)
  );
}
