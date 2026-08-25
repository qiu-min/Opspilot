import type { Context } from '../contracts/context.js';
import type { ModelEventStream } from '../contracts/events.js';
import type { Model } from '../contracts/model.js';
import type { ResolvedProvider } from '../provider-config.js';
import type { ResolvedOptions } from '../thinking.js';
export interface ModelAdapter {
  readonly api: string;
  stream(
    model: Model,
    context: Context,
    options: ResolvedOptions,
    provider: ResolvedProvider,
  ): ModelEventStream;
}
