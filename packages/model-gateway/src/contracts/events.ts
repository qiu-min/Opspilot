import type { AssistantMessage, ModelToolCall } from './context.js';
import { ModelGatewayError, toModelGatewayError } from './errors.js';
import type { Model } from './model.js';
import type { Usage } from './response.js';

export type ModelStreamEvent =
  | { readonly type: 'start'; readonly model: Model }
  | { readonly type: 'text.delta'; readonly contentIndex: number; readonly delta: string }
  | {
      readonly type: 'tool-call.delta';
      readonly contentIndex: number;
      readonly callId: string;
      readonly delta: string;
    }
  | {
      readonly type: 'tool-call.completed';
      readonly contentIndex: number;
      readonly toolCall: ModelToolCall;
    }
  | { readonly type: 'usage'; readonly usage: Usage }
  | { readonly type: 'done'; readonly response: AssistantMessage }
  | { readonly type: 'error'; readonly error: ModelGatewayError };

export interface ModelEventStream extends AsyncIterable<ModelStreamEvent> {
  result(): Promise<AssistantMessage>;
}

export type StreamController = {
  emit(event: ModelStreamEvent): void;
  complete(response: AssistantMessage): void;
  fail(error: ModelGatewayError): void;
};

class BufferedStream implements ModelEventStream, StreamController {
  private queue: ModelStreamEvent[] = [];
  private waiters: ((value: IteratorResult<ModelStreamEvent>) => void)[] = [];
  private closed = false;
  private resolve!: (response: AssistantMessage) => void;
  private reject!: (error: ModelGatewayError) => void;
  private completion = new Promise<AssistantMessage>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });

  constructor(producer: (controller: StreamController) => Promise<void>) {
    void this.completion.catch(() => undefined);
    void producer(this).catch((error) => this.fail(toModelGatewayError(error)));
  }

  emit(event: ModelStreamEvent) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  complete(response: AssistantMessage) {
    if (this.closed) return;
    this.emit({ type: 'done', response });
    this.closed = true;
    this.resolve(response);
    this.finish();
  }

  fail(error: ModelGatewayError) {
    if (this.closed) return;
    this.emit({ type: 'error', error });
    this.closed = true;
    this.reject(error);
    this.finish();
  }

  result() {
    return this.completion;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ModelStreamEvent> {
    while (true) {
      const next = await this.next();
      if (next.done) return;
      yield next.value;
    }
  }

  private next(): Promise<IteratorResult<ModelStreamEvent>> {
    const event = this.queue.shift();
    if (event) return Promise.resolve({ value: event, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private finish() {
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }
}

export function createModelEventStream(
  producer: (controller: StreamController) => Promise<void>,
): ModelEventStream {
  return new BufferedStream(producer);
}
