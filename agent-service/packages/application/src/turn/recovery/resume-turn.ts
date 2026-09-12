import type { AgentMessage } from '@opspilot/agent-runtime';
import type { Model, ModelGateway } from '@opspilot/model-gateway';
import { Turn, type Session, type TurnEvent } from '@opspilot/domain';

import { createAgentSession } from '../../session/runtime/create-agent-session.js';
import type { AgentSession } from '../../session/runtime/agent-session.js';
import type { CompactionService, CompactionSettings, ContextManager } from '../../context/index.js';
import type { SessionStore } from '../../session/ports/session-store.js';
import type { ToolDefinition } from '../../tools/tool-definition.js';
import { wrapToolDefinitions } from '../../tools/wrap-tool-definition.js';
import type { TurnExecutionContext } from '../execution/turn-execution-context.js';
import type { TurnExecutionContextStore } from '../ports/turn-execution-context-store.js';
import type { TurnStore } from '../ports/turn-store.js';
import {
  TurnStreamProjector,
  type TurnStreamHub,
} from '../stream/index.js';
import type { ToolPresentationResolver } from '../presentation/tool-presentation.js';
import { TurnEventRecorder } from '../execution/turn-event-recorder.js';
import { withExcelResourceGuidance } from '../../system-prompt/index.js';
import {
  InMemorySessionRunCoordinator,
  type SessionRunCoordinator,
} from '../execution/session-run-coordinator.js';
import { TurnRecoveryPlanner } from './turn-recovery-planner.js';
import type { TurnRecoveryPlan } from './turn-recovery-plan.js';

const SAFE_TURN_FAILURE_MESSAGE = 'Turn failed.';

export interface ResumeTurnDependencies {
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
  readonly toolPresentationResolver?: ToolPresentationResolver;
  readonly planner?: TurnRecoveryPlanner;
}

export type ResumeTurnResultKind =
  'resumed' | 'reconciled' | 'ignored' | 'blocked' | 'unrecoverable';

export interface ResumeTurnResult {
  readonly kind: ResumeTurnResultKind;
  readonly turnId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly plan?: TurnRecoveryPlan;
  readonly messages?: readonly AgentMessage[];
}

/** Reconstructs and resumes one existing durable Turn. */
export class ResumeTurn {
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
  private readonly toolPresentationResolver?: ToolPresentationResolver;
  private readonly planner: TurnRecoveryPlanner;

  public constructor(options: ResumeTurnDependencies) {
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
    this.toolPresentationResolver = options.toolPresentationResolver;
    this.planner = options.planner ?? new TurnRecoveryPlanner();
  }

  /** Loads the Turn inside the shared Session critical section before planning recovery. */
  public async execute(turnId: string): Promise<ResumeTurnResult> {
    const initial = this.turnStore.load(turnId);
    return await this.sessionRunCoordinator.runExclusive(initial.getSessionId(), async () => {
      const turn = this.turnStore.load(turnId);
      return await this.executeLoadedTurn(turn);
    });
  }

  private async executeLoadedTurn(turn: Turn): Promise<ResumeTurnResult> {
    const initialState = turn.getState();
    const sessionId = initialState.sessionId;
    const events = this.turnStore.loadEvents(turn.getId());

    if (isTerminalStatus(initialState.status)) {
      return { kind: 'ignored', turnId: turn.getId(), sessionId, attempt: initialState.attempt };
    }

    const session = this.sessionStore.load(sessionId);
    let plan = this.planner.plan({
      turn,
      events,
      session,
      toolDefinitions: this.toolDefinitions,
    });

    if (plan.kind === 'reconcile_terminal') {
      if (!isTerminalStatus(turn.getState().status)) {
        turn.reconcileTerminal(
          terminalStatus(plan.terminalEvent),
          plan.terminalEvent.type === 'turn_completed'
            ? plan.terminalEvent.resultLeafId
            : turn.getState().resultLeafId,
          plan.terminalEvent.timestamp,
        );
        this.turnStore.save(turn);
      }
      return {
        kind: 'reconciled',
        turnId: turn.getId(),
        sessionId,
        attempt: turn.getState().attempt,
        plan,
      };
    }

    if (turn.getState().status === 'running') {
      turn.markInterrupted();
      this.turnStore.save(turn);
      plan = this.planner.plan({
        turn,
        events,
        session,
        toolDefinitions: this.toolDefinitions,
      });
    }

    if (plan.kind === 'reconcile_terminal') {
      turn.reconcileTerminal(
        terminalStatus(plan.terminalEvent),
        plan.terminalEvent.type === 'turn_completed'
          ? plan.terminalEvent.resultLeafId
          : turn.getState().resultLeafId,
        plan.terminalEvent.timestamp,
      );
      this.turnStore.save(turn);
      return {
        kind: 'reconciled',
        turnId: turn.getId(),
        sessionId,
        attempt: turn.getState().attempt,
        plan,
      };
    }

    if (plan.kind === 'blocked' || plan.kind === 'unrecoverable') {
      return {
        kind: plan.kind,
        turnId: turn.getId(),
        sessionId,
        attempt: turn.getState().attempt,
        plan,
      };
    }

    const checkpoint = 'effectiveCheckpoint' in plan ? plan.effectiveCheckpoint : undefined;
    if (checkpoint !== undefined && isNewerCheckpoint(checkpoint, turn.getState().checkpoint)) {
      turn.advanceCheckpoint(checkpoint);
      this.turnStore.save(turn);
    }

    if (plan.kind === 'complete_from_assistant') {
      session.branch(plan.sessionLeafId);
      this.resumeAttempt(turn);
      const recorder = new TurnEventRecorder(turn, this.turnStore, session);
      recorder.recordTurnResumed();
      this.openStream(turn, sessionId);
      recorder.recordTurnCompleted(plan.sessionLeafId);
      this.publishTerminal(turn, sessionId, {
        type: 'turn_completed',
        resultLeafId: plan.sessionLeafId,
      });
      return {
        kind: 'resumed',
        turnId: turn.getId(),
        sessionId,
        attempt: turn.getState().attempt,
        plan,
        messages: [],
      };
    }

    session.branch(plan.sessionLeafId);
    const executionContext = this.turnExecutionContextStore?.load(turn.getId());
    if (
      plan.kind === 'resume_tools' &&
      this.requiresMissingExecutionInput(plan, executionContext)
    ) {
      return {
        kind: 'blocked',
        turnId: turn.getId(),
        sessionId,
        attempt: turn.getState().attempt,
        plan: {
          kind: 'blocked',
          reason: 'Recovery requires a missing durable TurnExecutionContext.',
          callIds: plan.pendingToolCalls.map((call) => call.callId),
          effectiveCheckpoint: plan.effectiveCheckpoint,
        },
      };
    }

    this.resumeAttempt(turn);
    const recorder = new TurnEventRecorder(turn, this.turnStore, session);
    recorder.recordTurnResumed();
    this.openStream(turn, sessionId);
    const streamChannelOpened = this.turnStreamHub !== undefined;
    const projector = new TurnStreamProjector({
      turnId: turn.getId(),
      sessionId,
      toolPresentationResolver: this.toolPresentationResolver,
    });
    let agentSession: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let terminalPublished = false;
    try {
      agentSession = createAgentSession({
        session,
        sessionStore: this.sessionStore,
        modelGateway: this.modelGateway,
        tools: wrapToolDefinitions(this.toolDefinitions, {
          sessionId,
          ...(executionContext?.excelResource === undefined
            ? {}
            : { excelResource: executionContext.excelResource }),
        }),
        systemPrompt: withExcelResourceGuidance(
          this.systemPrompt,
          executionContext?.excelResource !== undefined,
        ),
        contextManager: this.contextManager,
        compactionService: this.compactionService,
        compactionSettings: this.compactionSettings,
      });
      unsubscribe = agentSession.subscribe(async (event) => {
        recorder.recordAgentSessionEvent(event);
        for (const streamEvent of projector.project(event))
          this.turnStreamHub?.publish(streamEvent);
      });

      const messages =
        plan.kind === 'resume_tools'
          ? await agentSession.continueFromToolCalls(plan.assistantMessage, plan.pendingToolCalls)
          : await agentSession.continue();
      const errorInfo = agentSession.state.errorInfo;
      if (errorInfo === undefined) {
        recorder.recordTurnCompleted(session.getLeafId());
        this.publishTerminal(turn, sessionId, {
          type: 'turn_completed',
          resultLeafId: session.getLeafId(),
        });
      } else if (errorInfo.reason === 'aborted') {
        recorder.recordTurnCancelled();
        this.publishTerminal(turn, sessionId, { type: 'turn_cancelled' });
      } else {
        recorder.recordTurnFailed(errorInfo.message);
        this.publishTerminal(turn, sessionId, {
          type: 'turn_failed',
          message: SAFE_TURN_FAILURE_MESSAGE,
        });
      }
      terminalPublished = true;
      return {
        kind: 'resumed',
        turnId: turn.getId(),
        sessionId,
        attempt: turn.getState().attempt,
        plan,
        messages,
      };
    } catch (error: unknown) {
      if (turn.getState().status === 'running') {
        try {
          recorder.recordTurnFailed(error instanceof Error ? error.message : String(error));
        } catch {
          // Preserve the original recovery failure.
        }
      }
      if (
        streamChannelOpened &&
        !terminalPublished &&
        turn.getState().status !== 'completed' &&
        turn.getState().status !== 'cancelled'
      ) {
        this.publishTerminal(turn, sessionId, {
          type: 'turn_failed',
          message: SAFE_TURN_FAILURE_MESSAGE,
        });
        terminalPublished = true;
      }
      throw error;
    } finally {
      unsubscribe?.();
      if (!terminalPublished) this.turnStreamHub?.closeTurn(turn.getId());
      if (agentSession !== undefined) agentSession.dispose();
    }
  }

  private resumeAttempt(turn: Turn): void {
    turn.resume();
    this.turnStore.save(turn);
  }

  private openStream(turn: Turn, sessionId: string): void {
    this.turnStreamHub?.openTurn({ turnId: turn.getId(), sessionId });
    this.turnStreamHub?.publish({ type: 'turn_started', turnId: turn.getId(), sessionId });
  }

  private publishTerminal(
    turn: Turn,
    sessionId: string,
    event:
      | { readonly type: 'turn_completed'; readonly resultLeafId: string | null }
      | { readonly type: 'turn_failed'; readonly message: string }
      | { readonly type: 'turn_cancelled' },
  ): void {
    if (this.turnStreamHub === undefined) return;
    this.turnStreamHub.publish({ turnId: turn.getId(), sessionId, ...event });
    this.turnStreamHub.closeTurn(turn.getId());
  }

  private requiresMissingExecutionInput(
    plan: Extract<TurnRecoveryPlan, { kind: 'resume_tools' }>,
    context: TurnExecutionContext | null | undefined,
  ): boolean {
    if (context?.excelResource !== undefined) return false;
    return plan.pendingToolCalls.some(
      (call) =>
        this.toolDefinitions.find((definition) => definition.name === call.name)
          ?.requiresExcelResource,
    );
  }
}

function isTerminalStatus(status: ReturnType<Turn['getState']>['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function terminalStatus(
  event: Extract<TurnEvent, { type: 'turn_completed' | 'turn_failed' | 'turn_cancelled' }>,
): 'completed' | 'failed' | 'cancelled' {
  return event.type === 'turn_completed'
    ? 'completed'
    : event.type === 'turn_failed'
      ? 'failed'
      : 'cancelled';
}

function isNewerCheckpoint(
  checkpoint: NonNullable<ReturnType<Turn['getState']>['checkpoint']>,
  current: ReturnType<Turn['getState']>['checkpoint'],
): boolean {
  return current === null || checkpoint.eventSequence > current.eventSequence;
}
