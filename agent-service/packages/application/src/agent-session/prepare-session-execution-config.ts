import { clampThinkingLevel, type Model, type ModelGateway } from '@opspilot/model-gateway';
import type { AgentThinkingLevel } from '@opspilot/agent-runtime';
import type { Session } from '@opspilot/domain';

import { buildSessionContext } from '../session/session-context.js';
import type { SessionStore } from '../session-store/session-store.js';

/** Inputs used to resolve and durably prepare one Turn's runtime configuration. */
export interface PrepareSessionExecutionConfigOptions {
  readonly session: Session;
  readonly sessionStore: SessionStore;
  readonly modelGateway: ModelGateway;
  readonly model?: Model;
  readonly defaultModel?: Model;
  readonly thinkingLevel?: AgentThinkingLevel;
  readonly created: boolean;
}

/** The canonical runtime configuration after Session persistence is complete. */
export interface PreparedSessionExecutionConfig {
  readonly model: Model;
  readonly thinkingLevel: AgentThinkingLevel;
}

/**
 * Resolves model/thinking overrides and persists their Session entries before user input.
 * This is intentionally outside createAgentSession so its construction is side-effect free.
 */
export function prepareSessionExecutionConfig(
  options: PrepareSessionExecutionConfigOptions,
): PreparedSessionExecutionConfig {
  const sessionContext = buildSessionContext(options.session);
  const model = resolveModel(options, sessionContext.model);
  const thinkingLevel = resolveThinkingLevel(
    model,
    options.thinkingLevel,
    sessionContext.thinkingLevel,
  );

  persistExecutionConfig(
    options,
    model,
    thinkingLevel,
    sessionContext.model,
    sessionContext.thinkingLevel,
  );

  return { model, thinkingLevel };
}

function resolveModel(
  options: PrepareSessionExecutionConfigOptions,
  sessionModel: ReturnType<typeof buildSessionContext>['model'],
): Model {
  const requestedModel = options.model ?? (options.created ? options.defaultModel : undefined);
  if (requestedModel !== undefined) {
    const canonicalModel = options.modelGateway.getModel(
      requestedModel.provider,
      requestedModel.id,
    );
    if (canonicalModel !== undefined) return canonicalModel;
    throw new Error(
      `Explicit model ${requestedModel.provider}/${requestedModel.id} is not registered in the model gateway.`,
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

  throw new Error('No model is configured for the current Session.');
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

function persistExecutionConfig(
  options: PrepareSessionExecutionConfigOptions,
  model: Model,
  thinkingLevel: AgentThinkingLevel,
  restoredModel: ReturnType<typeof buildSessionContext>['model'],
  restoredThinkingLevel: AgentThinkingLevel,
): void {
  if (
    options.created ||
    restoredModel === null ||
    restoredModel.provider !== model.provider ||
    restoredModel.modelId !== model.id
  ) {
    appendAndPersist(options, () => options.session.appendModelChange(model.provider, model.id));
  }

  if (options.created || thinkingLevel !== restoredThinkingLevel) {
    appendAndPersist(options, () => options.session.appendThinkingLevelChange(thinkingLevel));
  }
}

function appendAndPersist(
  options: PrepareSessionExecutionConfigOptions,
  append: () => Parameters<SessionStore['appendEntry']>[1],
): void {
  const entry = append();
  options.sessionStore.appendEntry(options.session.getId(), entry);
}
