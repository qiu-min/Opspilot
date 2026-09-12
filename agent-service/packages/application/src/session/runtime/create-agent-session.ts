import { clampThinkingLevel, type Model, type ModelGateway } from '@opspilot/model-gateway';
import { Agent, type AgentThinkingLevel, type AgentTool } from '@opspilot/agent-runtime';
import { Session } from '@opspilot/domain';

import {
  DEFAULT_COMPACTION_SETTINGS,
  DefaultCompactionService,
  DefaultContextManager,
  type CompactionService,
  type CompactionSettings,
  type ContextManager,
} from '../../context/index.js';
import { buildSessionContext } from './session-context.js';
import type { SessionStore } from '../ports/session-store.js';
import { AgentSession } from './agent-session.js';

export interface CreateAgentSessionOptions {
  readonly session: Session;
  /** Retained for callers migrating to prepareSessionExecutionConfig; it is never written to. */
  readonly sessionStore?: SessionStore;
  readonly modelGateway: ModelGateway;
  readonly model?: Model;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly tools?: readonly AgentTool[];
  readonly systemPrompt?: string;
  readonly contextManager?: ContextManager;
  readonly compactionService?: CompactionService;
  readonly compactionSettings?: CompactionSettings;
}

/** 从 Session 上下文组装 Model、Agent Runtime 和 AgentSession。 */
export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  const sessionContext = buildSessionContext(options.session);
  const model = resolveModel(options, sessionContext.model);
  const thinkingLevel = resolveThinkingLevel(
    model,
    options.thinkingLevel,
    sessionContext.thinkingLevel,
  );
  const contextManager = options.contextManager ?? new DefaultContextManager();
  const tools = options.tools ?? [];
  const compactionService =
    options.compactionService ?? new DefaultCompactionService(options.modelGateway);
  const compactionSettings = options.compactionSettings ?? DEFAULT_COMPACTION_SETTINGS;

  const agent = new Agent({
    model,
    thinkingLevel,
    messages: sessionContext.messages,
    tools,
    systemPrompt: options.systemPrompt,
    transformContext: async (messages, signal) => {
      const result = await contextManager.prepare({
        messages,
        model,
        systemPrompt: options.systemPrompt,
        tools,
        signal,
      });

      return [...result.messages];
    },
    streamFn: (streamModel, context, streamOptions) =>
      options.modelGateway.stream(streamModel, context, streamOptions),
  });

  return new AgentSession({
    agent,
    session: options.session,
    sessionStore: options.sessionStore,
    compactionService,
    compactionSettings,
  });
}

function resolveModel(
  options: CreateAgentSessionOptions,
  sessionModel: ReturnType<typeof buildSessionContext>['model'],
): Model {
  if (options.model !== undefined) {
    const canonicalModel = options.modelGateway.getModel(options.model.provider, options.model.id);
    if (canonicalModel !== undefined) return canonicalModel;
    throw new Error(
      `Explicit model ${options.model.provider}/${options.model.id} is not registered in the model gateway.`,
    );
  }

  if (sessionModel !== null) {
    const restored = options.modelGateway.getModel(sessionModel.provider, sessionModel.modelId);
    if (restored !== undefined) return restored;
    throw new Error(
      `Unable to restore session model ${sessionModel.provider}/${sessionModel.modelId}. ` +
        'The model is not registered in the model gateway.',
    );
  }

  throw new Error('createAgentSession requires a model for the current session');
}

function resolveThinkingLevel(
  model: Model,
  override: AgentThinkingLevel | undefined,
  restored: AgentThinkingLevel,
): AgentThinkingLevel {
  const requested = override ?? restored;
  if (requested === 'off') return 'off';
  return clampThinkingLevel(model, requested);
}
