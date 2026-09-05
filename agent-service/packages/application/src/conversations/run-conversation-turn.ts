import type { Model, ModelGateway } from '@opspilot/model-gateway';

import { createAgentSession } from '../agent-session/create-agent-session.js';
import type { CompactionService, CompactionSettings, ContextManager } from '../context/index.js';
import type { SessionStore } from '../session-store/session-store.js';
import type { ToolDefinition } from '../tools/tool-definition.js';
import { wrapToolDefinitions } from '../tools/wrap-tool-definition.js';
import type {
  RunConversationTurnExecutionOptions,
  RunConversationTurnInput,
  RunConversationTurnResult,
} from './conversation-types.js';
import {
  InMemorySessionRunCoordinator,
  type SessionRunCoordinator,
} from './session-run-coordinator.js';

/** Dependencies used to run one application-level conversation turn. */
export interface RunConversationTurnOptions {
  readonly sessionStore: SessionStore;
  readonly modelGateway: ModelGateway;
  readonly toolDefinitions: readonly ToolDefinition[];
  readonly defaultModel?: Model;
  readonly systemPrompt?: string;
  readonly contextManager?: ContextManager;
  readonly compactionService?: CompactionService;
  readonly compactionSettings?: CompactionSettings;
  readonly sessionRunCoordinator?: SessionRunCoordinator;
}

/** Orchestrates session loading, AgentSession execution, and turn results. */
export class RunConversationTurn {
  private readonly sessionStore: SessionStore;
  private readonly modelGateway: ModelGateway;
  private readonly toolDefinitions: readonly ToolDefinition[];
  private readonly defaultModel?: Model;
  private readonly systemPrompt?: string;
  private readonly contextManager?: ContextManager;
  private readonly compactionService?: CompactionService;
  private readonly compactionSettings?: CompactionSettings;
  private readonly sessionRunCoordinator: SessionRunCoordinator;

  public constructor(options: RunConversationTurnOptions) {
    this.sessionStore = options.sessionStore;
    this.modelGateway = options.modelGateway;
    this.toolDefinitions = [...options.toolDefinitions];
    this.defaultModel = options.defaultModel;
    this.systemPrompt = options.systemPrompt;
    this.contextManager = options.contextManager;
    this.compactionService = options.compactionService;
    this.compactionSettings = options.compactionSettings;
    this.sessionRunCoordinator =
      options.sessionRunCoordinator ?? new InMemorySessionRunCoordinator();
  }

  /** Executes one turn and returns only the messages produced by that turn. */
  public async execute(
    input: RunConversationTurnInput,
    options?: RunConversationTurnExecutionOptions,
  ): Promise<RunConversationTurnResult> {
    if (input.sessionId !== undefined) {
      return await this.sessionRunCoordinator.runExclusive(input.sessionId, () =>
        this.executeTurn(input, options),
      );
    }

    return await this.executeTurn(input, options);
  }

  /** Loads or creates the session and runs the complete AgentSession lifecycle. */
  private async executeTurn(
    input: RunConversationTurnInput,
    options?: RunConversationTurnExecutionOptions,
  ): Promise<RunConversationTurnResult> {
    const created = input.sessionId === undefined;
    const sessionManager = created
      ? this.sessionStore.create()
      : this.sessionStore.load(input.sessionId);
    const sessionId = sessionManager.getHeader().id;
    await options?.onEvent?.({ type: 'session_ready', sessionId, created });

    const tools = wrapToolDefinitions(this.toolDefinitions, {
      sessionId,
      ...(input.excelResource === undefined ? {} : { excelResource: input.excelResource }),
    });
    const agentSession = createAgentSession({
      sessionManager,
      modelGateway: this.modelGateway,
      model: input.model ?? (input.sessionId === undefined ? this.defaultModel : undefined),
      thinkingLevel: input.thinkingLevel,
      tools,
      systemPrompt: this.systemPrompt,
      contextManager: this.contextManager,
      compactionService: this.compactionService,
      compactionSettings: this.compactionSettings,
    });

    let unsubscribe: (() => void) | undefined;
    try {
      if (options?.onEvent !== undefined) {
        unsubscribe = agentSession.subscribe(async (event) => {
          await options.onEvent?.(event);
        });
      }

      const messages = await agentSession.prompt(input.message);

      return {
        sessionId,
        leafId: sessionManager.getLeafId(),
        messages,
      };
    } finally {
      unsubscribe?.();
      agentSession.dispose();
    }
  }
}
