import { ModelGatewayError } from './contracts/errors.js';
import type { Model, ModelThinkingLevel, ThinkingLevel } from './contracts/model.js';
import type { Options } from './contracts/options.js';

const levels: readonly ModelThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high'];

export interface ResolvedReasoning {
  readonly requested: ThinkingLevel;
  readonly selected: ModelThinkingLevel;
  readonly providerValue: string;
  readonly protocol: NonNullable<Model['reasoningProtocol']>;
}

export interface ResolvedOptions extends Options {
  readonly resolvedReasoning?: ResolvedReasoning;
}

export function getSupportedThinkingLevels(model: Model): readonly ModelThinkingLevel[] {
  if (!model.reasoning) return ['off'];

  return levels.filter((level) => {
    if (level === 'off') return model.thinkingLevelMap?.off !== null;
    return typeof model.thinkingLevelMap?.[level] === 'string';
  });
}

export function clampThinkingLevel(model: Model, requested: ThinkingLevel): ModelThinkingLevel {
  const supported = getSupportedThinkingLevels(model);
  if (supported.includes(requested)) return requested;

  const requestedIndex = levels.indexOf(requested);
  for (let index = requestedIndex + 1; index < levels.length; index += 1) {
    const candidate = levels[index]!;
    if (supported.includes(candidate)) return candidate;
  }
  for (let index = requestedIndex - 1; index >= 0; index -= 1) {
    const candidate = levels[index]!;
    if (supported.includes(candidate)) return candidate;
  }
  throw new ModelGatewayError(
    'UNSUPPORTED_CAPABILITY',
    `Model ${model.provider}/${model.id} has no supported reasoning level.`,
  );
}

export function resolveThinking(model: Model, options: Options): ResolvedOptions {
  if (options.reasoning === undefined) return options;
  if (!model.reasoning)
    throw new ModelGatewayError(
      'UNSUPPORTED_CAPABILITY',
      `Model ${model.provider}/${model.id} does not support reasoning.`,
    );

  const selected = clampThinkingLevel(model, options.reasoning);
  const providerValue = model.thinkingLevelMap?.[selected];
  if (typeof providerValue !== 'string' || model.reasoningProtocol === undefined)
    throw new ModelGatewayError(
      'CONFIGURATION',
      `Model ${model.provider}/${model.id} lacks a reasoning mapping for ${selected}.`,
    );

  return {
    ...options,
    resolvedReasoning: {
      requested: options.reasoning,
      selected,
      providerValue,
      protocol: model.reasoningProtocol,
    },
  };
}
