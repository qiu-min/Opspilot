import { EventEmitter } from 'node:events';

import {
  GetActiveTurn,
  GetSessionHistory,
  SubscribeTurnStream,
  type TurnStreamEvent,
  type TurnStreamEventDraftPayload,
  type TurnStreamHub,
} from '@opspilot/application';
import { describe, expect, it } from 'vitest';

import { SessionsController } from '../src/sessions/sessions.controller.js';
import { TurnsController } from '../src/turns/turns.controller.js';
import type { ExcelResourcePathResolver } from '../src/sessions/excel-resource-path-resolver.js';

const identity = {
  turnId: 'turn-1',
  sessionId: '00000000-0000-4000-8000-000000000001',
};

class FakeResponse extends EventEmitter {
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  writableEnded = false;
  destroyed = false;

  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
}

const resolver: ExcelResourcePathResolver = {
  resolve(resource) {
    return { id: resource.id, filePath: resource.storagePath };
  },
};

describe('Turn stream API', () => {
  it('returns the live projection from the Session-first active-turn query', () => {
    const hub = {
      getActiveTurn: () => ({
        ...identity,
        status: 'running' as const,
        projection: {
          ...identity,
          status: 'running' as const,
          assistant: { text: 'partial', messageVisible: true, isThinking: false },
          tools: [],
          compaction: { status: 'idle' as const },
          usage: null,
          lastSequence: 1,
        },
      }),
    } as unknown as TurnStreamHub;
    const controller = new SessionsController(
      { execute: () => ({ leafId: null, items: [] }) } as unknown as GetSessionHistory,
      new GetActiveTurn(hub),
    );

    expect(controller.getActiveTurnSnapshot(identity.sessionId)).toEqual({
      activeTurn: {
        turnId: identity.turnId,
        sessionId: identity.sessionId,
        status: 'running',
        projection: expect.objectContaining({
          assistant: expect.objectContaining({ text: 'partial' }),
          lastSequence: 1,
        }),
      },
    });
  });

  it('writes reattached events as id/type/data SSE frames and ends after terminal', async () => {
    const events = [
      streamEvent({ type: 'assistant_text_delta', delta: 'hello' }, 1),
      streamEvent({ type: 'turn_completed', resultLeafId: null }, 2),
    ];
    const hub = createStreamHub(events);
    const controller = new TurnsController(
      {
        execute: async () => {
          throw new Error('not used');
        },
      } as never,
      resolver,
      new SubscribeTurnStream(hub),
    );
    const request = new EventEmitter();
    const response = new FakeResponse();
    const operation = controller.reattachTurnStream(
      identity.turnId,
      '0',
      request as never,
      response as never,
    );

    await operation;

    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.chunks.join('')).toContain('id: 1\nevent: assistant_text_delta\ndata:');
    expect(response.chunks.join('')).toContain('id: 2\nevent: turn_completed');
    expect(response.writableEnded).toBe(true);
  });

  it('disconnects only the subscriber and leaves the live channel active', async () => {
    let returned = false;
    let resolveNext!: (result: IteratorResult<TurnStreamEvent>) => void;
    const hub = {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<TurnStreamEvent>>((resolve) => {
              resolveNext = resolve;
            }),
          return: async () => {
            returned = true;
            resolveNext({ value: undefined, done: true });
            return { value: undefined, done: true };
          },
        }),
      }),
    } as unknown as TurnStreamHub;
    const controller = new TurnsController(
      {
        execute: async () => {
          throw new Error('not used');
        },
      } as never,
      resolver,
      new SubscribeTurnStream(hub),
    );
    const request = new EventEmitter();
    const response = new FakeResponse();
    const operation = controller.reattachTurnStream(
      identity.turnId,
      undefined,
      request as never,
      response as never,
    );
    response.emit('close');
    await operation;

    expect(returned).toBe(true);
  });
});

function createStreamHub(events: readonly TurnStreamEvent[]): TurnStreamHub {
  return {
    subscribe: () => ({
      [Symbol.asyncIterator]: () => {
        let index = 0;
        return {
          next: async (): Promise<IteratorResult<TurnStreamEvent>> => {
            const event = events[index++];
            return event === undefined
              ? { value: undefined, done: true }
              : { value: event, done: false };
          },
          return: async () => ({ value: undefined, done: true }),
        };
      },
    }),
  } as unknown as TurnStreamHub;
}

function streamEvent(payload: TurnStreamEventDraftPayload, sequence: number): TurnStreamEvent {
  return {
    ...payload,
    ...identity,
    sequence,
    timestamp: new Date(sequence * 1_000).toISOString(),
  } as TurnStreamEvent;
}
