import type { AssistantMessage, Context } from './contracts/context.js';
import type { Model } from './contracts/model.js';
import type { Options } from './contracts/options.js';
import type { ModelEventStream } from './contracts/events.js';

export interface ModelProviderDescriptor {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly models: readonly Model[];
}

export interface ModelGateway {
  getProviders(): readonly ModelProviderDescriptor[];
  getModels(providerId?: string): readonly Model[];
  getModel(providerId: string, modelId: string): Model | undefined;
  stream(model: Model, context: Context, options?: Options): ModelEventStream;
  complete(model: Model, context: Context, options?: Options): Promise<AssistantMessage>;
}
