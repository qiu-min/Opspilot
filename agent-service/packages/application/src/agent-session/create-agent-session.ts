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
} from '../context/index.js';
import { buildSessionContext } from '../session/session-context.js';
import type { SessionStore } from '../session-store/session-store.js';
import { AgentSession } from './agent-session.js';

export interface CreateAgentSessionOptions {
  readonly session: Session;
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
  const isNewSession = options.session.getEntries().length === 0;
  const model = resolveModel(options, sessionContext.model, isNewSession);
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

  persistInitialOrOverriddenState(
    options.session,
    options.sessionStore,
    model,
    thinkingLevel,
    sessionContext.model,
    sessionContext.thinkingLevel,
    isNewSession,
  );

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
  isNewSession: boolean,
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

  if (isNewSession) throw new Error('createAgentSession requires a model for a new session');
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

function persistInitialOrOverriddenState(
  session: Session,
  sessionStore: SessionStore | undefined,
  model: Model,
  thinkingLevel: AgentThinkingLevel,
  restoredModel: ReturnType<typeof buildSessionContext>['model'],
  restoredThinkingLevel: AgentThinkingLevel,
  isNewSession: boolean,
): void {
  if (isNewSession) {
    appendAndPersist(session, sessionStore, () =>
      session.appendModelChange(model.provider, model.id),
    );
    appendAndPersist(session, sessionStore, () => session.appendThinkingLevelChange(thinkingLevel));
    return;
  }

  if (
    restoredModel === null ||
    restoredModel.provider !== model.provider ||
    restoredModel.modelId !== model.id
  ) {
    appendAndPersist(session, sessionStore, () =>
      session.appendModelChange(model.provider, model.id),
    );
  }

  if (thinkingLevel !== restoredThinkingLevel) {
    appendAndPersist(session, sessionStore, () => session.appendThinkingLevelChange(thinkingLevel));
  }
}

function appendAndPersist(
  session: Session,
  sessionStore: SessionStore | undefined,
  append: () => Parameters<SessionStore['appendEntry']>[1],
): void {
  const entry = append();
  sessionStore?.appendEntry(session.getId(), entry);
}
