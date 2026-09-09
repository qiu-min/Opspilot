import type { Model, ModelGateway } from '@opspilot/model-gateway';
import { Turn } from '@opspilot/domain';

import {
  createAgentSession,
  prepareSessionExecutionConfig,
  type AgentSession,
} from '../agent-session/index.js';
import type { CompactionService, CompactionSettings, ContextManager } from '../context/index.js';
import type { Session } from '@opspilot/domain';
import type { SessionStore } from '../session-store/session-store.js';
import type { ToolDefinition } from '../tools/tool-definition.js';
import { wrapToolDefinitions } from '../tools/wrap-tool-definition.js';
import type { TurnStore } from '../turn-store/turn-store.js';
import type { TurnExecutionContextStore } from '../turn-execution/index.js';
import {
  TurnStreamProjector,
  TurnStreamSessionConflictError,
  type TurnStreamHub,
} from '../turn-stream/index.js';
import { TurnEventRecorder } from './turn-event-recorder.js';
import { withExcelResourceGuidance } from '../system-prompt/index.js';
import type { ExecuteTurnInput, ExecuteTurnOptions, ExecuteTurnResult } from './turn-types.js';
import {
  InMemorySessionRunCoordinator,
  type SessionRunCoordinator,
} from './session-run-coordinator.js';
import { SessionRecoverableTurnConflictError } from './turn-errors.js';

const SAFE_TURN_FAILURE_MESSAGE = 'Turn failed.';

/** Dependencies used to execute one application-level Turn. */
export interface ExecuteTurnDependencies {
  readonly sessionStore: SessionStore;
  readonly turnStore: TurnStore;
  readonly turnExecutionContextStore?: TurnExecutionContextStore;
  readonly modelGateway: ModelGateway;
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly defaultModel?: Model;
  readonly systemPrompt?: string;
  readonly contextManager?: ContextManager;
  readonly compactionService?: CompactionService;
  readonly compactionSettings?: CompactionSettings;
  readonly sessionRunCoordinator?: SessionRunCoordinator;
  readonly turnStreamHub?: TurnStreamHub;
}

/** Orchestrates Session input commit, Agent Runtime execution, and Turn durability. */
export class ExecuteTurn {
  private readonly sessionStore: SessionStore;
  private readonly turnStore: TurnStore;
  private readonly turnExecutionContextStore?: TurnExecutionContextStore;
  private readonly modelGateway: ModelGateway;
  private readonly toolDefinitions: readonly ToolDefinition[];
  private readonly defaultModel?: Model;
  private readonly systemPrompt?: string;
  private readonly contextManager?: ContextManager;
  private readonly compactionService?: CompactionService;
  private readonly compactionSettings?: CompactionSettings;
  private readonly sessionRunCoordinator: SessionRunCoordinator;
  private readonly turnStreamHub?: TurnStreamHub;

  public constructor(options: ExecuteTurnDependencies) {
    this.sessionStore = options.sessionStore;
    this.turnStore = options.turnStore;
    this.turnExecutionContextStore = options.turnExecutionContextStore;
    this.modelGateway = options.modelGateway;
    this.toolDefinitions = [...options.toolDefinitions];
    this.defaultModel = options.defaultModel;
    this.systemPrompt = options.systemPrompt;
    this.contextManager = options.contextManager;
    this.compactionService = options.compactionService;
    this.compactionSettings = options.compactionSettings;
    this.sessionRunCoordinator =
      options.sessionRunCoordinator ?? new InMemorySessionRunCoordinator();
    this.turnStreamHub = options.turnStreamHub;
  }

  /** Executes one Turn. Existing Sessions are loaded only after their queue is acquired. */
  public async execute(
    input: ExecuteTurnInput,
    options?: ExecuteTurnOptions,
  ): Promise<ExecuteTurnResult> {
    if (input.sessionId !== undefined) {
      return await this.sessionRunCoordinator.runExclusive(input.sessionId, async () => {
        const session = this.sessionStore.load(input.sessionId!);
        return await this.executeLoadedTurn(input, options, session, false);
      });
    }

    const session = this.sessionStore.create();
    return await this.sessionRunCoordinator.runExclusive(session.getId(), () =>
      this.executeLoadedTurn(input, options, session, true),
    );
  }

  private async executeLoadedTurn(
    input: ExecuteTurnInput,
    options: ExecuteTurnOptions | undefined,
    session: Session,
    created: boolean,
  ): Promise<ExecuteTurnResult> {
    const sessionId = session.getId();
    await options?.onEvent?.({ type: 'session_ready', sessionId, created });

    const activeTurn = this.turnStreamHub?.getActiveTurn(sessionId);
    if (activeTurn !== null && activeTurn !== undefined) {
      throw new TurnStreamSessionConflictError(sessionId, activeTurn.turnId);
    }
    const recoverableTurn = this.turnStore
      .listRecoverable()
      .find((candidate) => candidate.getSessionId() === sessionId);
    if (recoverableTurn !== undefined) {
      throw new SessionRecoverableTurnConflictError(sessionId, recoverableTurn.getId());
    }

    const turn = Turn.create({ sessionId, baseLeafId: session.getLeafId() });
    this.turnStore.create(turn);
    this.turnExecutionContextStore?.save(turn.getId(), {
      version: 1,
      ...(input.excelResource === undefined ? {} : { excelResource: input.excelResource }),
    });
    turn.start();
    this.turnStore.save(turn);

    const recorder = new TurnEventRecorder(turn, this.turnStore, session);
    recorder.recordTurnStarted();

    let agentSession: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let streamTerminalPublished = false;
    let streamChannelOpened = false;
    try {
      this.turnStreamHub?.openTurn({ turnId: turn.getId(), sessionId });
      streamChannelOpened = this.turnStreamHub !== undefined;
      this.turnStreamHub?.publish({
        type: 'turn_started',
        turnId: turn.getId(),
        sessionId,
      });
      await options?.onEvent?.({ type: 'turn_ready', turnId: turn.getId() });
      const executionConfig = prepareSessionExecutionConfig({
        session,
        sessionStore: this.sessionStore,
        modelGateway: this.modelGateway,
        model: input.model,
        defaultModel: this.defaultModel,
        thinkingLevel: input.thinkingLevel,
        created,
      });
      const inputEntry = session.appendMessage(input.message);
      this.sessionStore.appendEntry(sessionId, inputEntry);
      recorder.recordInputCommitted(inputEntry.id, inputEntry.id);

      const tools = wrapToolDefinitions(this.toolDefinitions, {
        sessionId,
        ...(input.excelResource === undefined ? {} : { excelResource: input.excelResource }),
      });
      agentSession = createAgentSession({
        session,
        sessionStore: this.sessionStore,
        modelGateway: this.modelGateway,
        model: executionConfig.model,
        thinkingLevel: executionConfig.thinkingLevel,
        tools,
        systemPrompt: withExcelResourceGuidance(
          this.systemPrompt,
          input.excelResource !== undefined,
        ),
        contextManager: this.contextManager,
        compactionService: this.compactionService,
        compactionSettings: this.compactionSettings,
      });

      const projector = new TurnStreamProjector({ turnId: turn.getId(), sessionId });
      unsubscribe = agentSession.subscribe(async (event) => {
        recorder.recordAgentSessionEvent(event);
        for (const streamEvent of projector.project(event)) {
          this.turnStreamHub?.publish(streamEvent);
        }
        await options?.onEvent?.(event);
      });

      const messages = await agentSession.continue();
      const errorInfo = agentSession.state.errorInfo;
      if (errorInfo === undefined) {
        recorder.recordTurnCompleted(session.getLeafId());
        this.publishTurnTerminal(turn.getId(), sessionId, {
          type: 'turn_completed',
          resultLeafId: session.getLeafId(),
        });
      } else if (errorInfo.reason === 'aborted') {
        recorder.recordTurnCancelled();
        this.publishTurnTerminal(turn.getId(), sessionId, { type: 'turn_cancelled' });
      } else {
        recorder.recordTurnFailed(errorInfo.message);
        this.publishTurnTerminal(turn.getId(), sessionId, {
          type: 'turn_failed',
          message: SAFE_TURN_FAILURE_MESSAGE,
        });
      }
      streamTerminalPublished = true;

      return {
        sessionId,
        turnId: turn.getId(),
        leafId: session.getLeafId(),
        messages: [input.message, ...messages],
      };
    } catch (error: unknown) {
      this.recordFailureBestEffort(turn, recorder, error);
      if (
        streamChannelOpened &&
        !streamTerminalPublished &&
        turn.getState().status !== 'completed' &&
        turn.getState().status !== 'cancelled'
      ) {
        this.publishTurnTerminal(turn.getId(), sessionId, {
          type: 'turn_failed',
          message: SAFE_TURN_FAILURE_MESSAGE,
        });
        streamTerminalPublished = true;
      }
      throw error;
    } finally {
      unsubscribe?.();
      if (streamChannelOpened && !streamTerminalPublished) {
        this.turnStreamHub?.closeTurn(turn.getId());
      }
      if (agentSession !== undefined) agentSession.dispose();
    }
  }

  private publishTurnTerminal(
    turnId: string,
    sessionId: string,
    event:
      | { readonly type: 'turn_completed'; readonly resultLeafId: string | null }
      | { readonly type: 'turn_failed'; readonly message: string }
      | { readonly type: 'turn_cancelled' },
  ): void {
    const turnStreamHub = this.turnStreamHub;
    if (turnStreamHub === undefined) return;
    turnStreamHub.publish({ turnId, sessionId, ...event });
    // The concrete in-memory Hub closes terminal channels during publish; keeping this
    // explicit makes terminal ownership part of the Application orchestration contract.
    turnStreamHub.closeTurn(turnId);
  }

  private recordFailureBestEffort(turn: Turn, recorder: TurnEventRecorder, error: unknown): void {
    if (turn.getState().status !== 'running') return;
    const message = error instanceof Error ? error.message : String(error);
    try {
      recorder.recordTurnFailed(message);
    } catch {
      // Preserve the original execution error. The TurnStore remains available for inspection.
    }
  }
}
