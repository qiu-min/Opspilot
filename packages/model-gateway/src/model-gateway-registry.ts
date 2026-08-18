import {
  type Context,
  type Model,
  type ModelEventStream,
  ModelGatewayError,
  type Options,
  validateContext,
  validateModel,
  validateOptions,
  AssistantMessage,
} from './contracts/index.js';
import {
  type ModelGatewayConfig,
  type ResolvedProvider,
  resolveProviders,
} from './provider-config.js';
import { OpenAiCompletionsModelAdapter } from './adapters/openai-completions-model-adapter.js';
import type { ModelAdapter } from './adapters/model-adapter.js';
import type { ModelGateway } from './model-gateway.js';
import { resolveThinking } from './thinking.js';
class Registry implements ModelGateway {
  private readonly providers: Map<string, ResolvedProvider>;
  private readonly adapters: Map<string, ModelAdapter>;
  constructor(config: ModelGatewayConfig, adapters: readonly ModelAdapter[]) {
    this.providers = new Map(resolveProviders(config).map((provider) => [provider.id, provider]));
    this.adapters = new Map(adapters.map((adapter) => [adapter.api, adapter]));
    for (const provider of this.providers.values())
      for (const model of provider.models)
        if (!this.adapters.has(model.api))
          throw new ModelGatewayError(
            'CONFIGURATION',
            `No model adapter is registered for API "${model.api}".`,
          );
  }
  getProviders() {
    return [...this.providers.values()].map(
      ({ apiKey: _apiKey, headers: _headers, timeoutMs: _timeoutMs, ...provider }) => provider,
    );
  }
  getModels(providerId?: string): readonly Model[] {
    return providerId
      ? (this.providers.get(providerId)?.models ?? [])
      : [...this.providers.values()].flatMap((provider) => provider.models);
  }
  getModel(providerId: string, modelId: string): Model | undefined {
    return this.providers.get(providerId)?.models.find((model) => model.id === modelId);
  }
  stream(rawModel: Model, rawContext: Context, rawOptions?: Options): ModelEventStream {
    const modelInput = validateModel(rawModel);
    const context = validateContext(rawContext);
    const options = validateOptions(rawOptions);
    const provider = this.providers.get(modelInput.provider);
    if (!provider)
      throw new ModelGatewayError(
        'CONFIGURATION',
        `Unknown model provider: ${modelInput.provider}`,
      );
    const model = this.getModel(provider.id, modelInput.id);
    if (!model || model.api !== modelInput.api || model.baseUrl !== modelInput.baseUrl)
      throw new ModelGatewayError(
        'CONFIGURATION',
        'Request model is not registered for its provider.',
      );
    const adapter = this.adapters.get(model.api);
    if (!adapter)
      throw new ModelGatewayError(
        'CONFIGURATION',
        `No model adapter is registered for API "${model.api}".`,
      );
    return adapter.stream(model, context, resolveThinking(model, options), provider);
  }
  complete(model: Model, context: Context, options?: Options): Promise<AssistantMessage> {
    return this.stream(model, context, options).result();
  }
}
export function createModelGateway(
  config: ModelGatewayConfig,
  adapters: readonly ModelAdapter[] = [new OpenAiCompletionsModelAdapter()],
): ModelGateway {
  return new Registry(config, adapters);
}
