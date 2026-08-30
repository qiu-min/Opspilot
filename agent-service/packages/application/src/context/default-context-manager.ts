import type {
  ContextManager,
  ContextPrepareInput,
  ContextPrepareResult,
} from './context-manager.js';

/** Keeps the complete input message list for Phase 1 context preparation. */
export class DefaultContextManager implements ContextManager {
  /** Returns an independent copy without changing the source message list. */
  public async prepare(input: ContextPrepareInput): Promise<ContextPrepareResult> {
    return { messages: [...input.messages] };
  }
}
