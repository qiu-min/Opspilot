import { clampThinkingLevel, type Model, type ModelGateway } from '@opspilot/model-gateway';
import { Agent, type AgentThinkingLevel, type AgentTool } from '@opspilot/agent-runtime';

import { SessionManager } from '../session/session-manager.js';
import type { ContextManager } from '../context/context-manager.js';
import { DefaultContextManager } from '../context/default-context-manager.js';
import { AgentSession } from './agent-session.js';

export interface CreateAgentSessionOptions {
  readonly sessionManager: SessionManager;
  readonly modelGateway: ModelGateway;
  readonly model?: Model;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly tools?: readonly AgentTool[];
  readonly systemPrompt?: string;
  readonly contextManager?: ContextManager;
}

/** 从 Session 上下文组装 Model、Agent Runtime 和 AgentSession。 */
export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  const sessionContext = options.sessionManager.buildSessionContext();
  const isNewSession = options.sessionManager.getEntries().length === 0;
  const model = resolveModel(options, sessionContext.model, isNewSession);
  const thinkingLevel = resolveThinkingLevel(
    model,
    options.thinkingLevel,
    sessionContext.thinkingLevel,
  );
  const contextManager = options.contextManager ?? new DefaultContextManager();
  const tools = options.tools ?? [];

  persistInitialOrOverriddenState(
    options.sessionManager,
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
    sessionManager: options.sessionManager,
  });
}

function resolveModel(
  options: CreateAgentSessionOptions,
  sessionModel: ReturnType<SessionManager['buildSessionContext']>['model'],
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
  sessionManager: SessionManager,
  model: Model,
  thinkingLevel: AgentThinkingLevel,
  restoredModel: ReturnType<SessionManager['buildSessionContext']>['model'],
  restoredThinkingLevel: AgentThinkingLevel,
  isNewSession: boolean,
): void {
  if (isNewSession) {
    sessionManager.appendModelChange(model.provider, model.id);
    sessionManager.appendThinkingLevelChange(thinkingLevel);
    return;
  }

  if (
    restoredModel === null ||
    restoredModel.provider !== model.provider ||
    restoredModel.modelId !== model.id
  ) {
    sessionManager.appendModelChange(model.provider, model.id);
  }

  if (thinkingLevel !== restoredThinkingLevel) {
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }
}
