import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { EventEmitter } from 'node:events';

import {
  ExecuteTurn,
  GetActiveTurn,
  GetSessionHistory,
  SubscribeTurnStream,
  type TurnStreamEvent,
  type TurnStreamEventDraftPayload,
  type TurnStreamHub,
} from '@opspilot/application';
import type { ExecuteTurnInput, ExecuteTurnResult } from '@opspilot/application';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiModule, EXCEL_RESOURCE_PATH_RESOLVER } from '../src/index.js';
import { TurnsController } from '../src/turns/turns.controller.js';
import type { ExcelResourcePathResolver } from '../src/sessions/excel-resource-path-resolver.js';

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

class FakeResponse extends EventEmitter {
  readonly headers: Record<string, string> = {};
  readonly chunks: string[] = [];
  headersSent = false;
  writableEnded = false;
  destroyed = false;

  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  write(chunk: string): boolean {
    this.headersSent = true;
    this.chunks.push(chunk);
    return true;
  }

  end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
}

const turnResult = createTurnResult('stop');
const sessionReadyId = '00000000-0000-4000-8000-000000000001';
const defaultExcelResourcePathResolver: ExcelResourcePathResolver = {
  resolve(resource) {
    return { id: resource.id, filePath: resource.storagePath };
  },
};

describe('Turn API', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs a JSON turn, maps the user string, and returns the public result', async () => {
    const execute = vi.fn<ExecuteTurn['execute']>(async (input) => {
      expect(input).toEqual({
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
        },
      });
      return turnResult;
    });
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/turns', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      sessionId: 'session-1',
      turnId: 'turn-1',
      leafId: 'leaf-1',
      status: 'completed',
      output: 'hello back',
    });
    expect(execute.mock.calls[0]).toHaveLength(1);
  });

  it('resolves an Excel resource without exposing its file path to the request contract', async () => {
    const resolve = vi.fn(() => ({ id: 'file-1', filePath: '/shared/uploads/report.xlsx' }));
    const execute = vi.fn<ExecuteTurn['execute']>(async (input) => {
      expect(input).toEqual({
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'inspect workbook' }],
        },
        excelResource: { id: 'file-1', filePath: '/shared/uploads/report.xlsx' },
      });
      return turnResult;
    });
    const server = await startServer(execute, { resolve });
    app = server.app;

    const response = await postJson(server.port, '/turns', {
      message: 'inspect workbook',
      excelResource: { id: 'file-1', storagePath: 'uploads/report.xlsx' },
    });

    expect(response.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ id: 'file-1', storagePath: 'uploads/report.xlsx' });
    expect(response.body).not.toContain('filePath');
  });

  it.each([
    {
      message: 'rejects an empty resource id',
      excelResource: { id: '', storagePath: 'report.xlsx' },
    },
    {
      message: 'rejects an empty storage path',
      excelResource: { id: 'file-1', storagePath: '' },
    },
    {
      message: 'rejects an absolute storage path',
      excelResource: { id: 'file-1', storagePath: '/shared/report.xlsx' },
    },
    {
      message: 'rejects a Windows absolute storage path',
      excelResource: { id: 'file-1', storagePath: 'C:\\shared\\report.xlsx' },
    },
    {
      message: 'rejects an extra file path field',
      excelResource: { id: 'file-1', storagePath: 'report.xlsx', filePath: '/shared/report.xlsx' },
    },
    {
      message: 'rejects a top-level file path field',
      excelResource: { id: 'file-1', storagePath: 'report.xlsx' },
      filePath: '/shared/report.xlsx',
    },
  ])('$message', async ({ excelResource, filePath }) => {
    const execute = vi.fn<ExecuteTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/turns', {
      message: 'inspect workbook',
      excelResource,
      ...(filePath === undefined ? {} : { filePath }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid JSON turn body', async () => {
    const execute = vi.fn<ExecuteTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postBody(server.port, '/turns', '{not-json');

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Invalid JSON body.',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('continues an empty body request without hanging', async () => {
    const execute = vi.fn<ExecuteTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postBody(server.port, '/turns', '');

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['error', 'error'],
    ['aborted', 'aborted'],
  ] as const)(
    'returns Agent finishReason %s as status %s without leaking errorMessage',
    async (finishReason, status) => {
      const execute = vi.fn<ExecuteTurn['execute']>(async () =>
        createTurnResult(finishReason, 'provider secret'),
      );
      const server = await startServer(execute);
      app = server.app;

      const response = await postJson(server.port, '/turns', {
        message: 'hello',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        sessionId: 'session-1',
        turnId: 'turn-1',
        leafId: 'leaf-1',
        status,
        output: '',
      });
      expect(response.body).not.toContain('provider secret');
    },
  );

  it('rejects a non-v4 sessionId before calling Application', async () => {
    const execute = vi.fn<ExecuteTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/turns', {
      sessionId: 'abc',
      message: 'hello',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects a route sessionId that conflicts with the body sessionId', async () => {
    const execute = vi.fn<ExecuteTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, `/sessions/${sessionReadyId}/turns`, {
      sessionId: '00000000-0000-4000-8000-000000000002',
      message: 'hello',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('writes Hub TurnStreamEvents in order and ends after a terminal event', async () => {
    const hub = createScriptedStreamHub([
      streamEvent({ type: 'turn_started' }, 0),
      streamEvent({ type: 'assistant_text_delta', delta: 'hello' }, 1),
      streamEvent({ type: 'tool_started', callId: 'call-1', name: 'lookup' }, 2),
      streamEvent({ type: 'turn_completed', resultLeafId: 'leaf-1' }, 3),
    ]);
    const execute: ExecuteTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'turn_ready', turnId: 'turn-1' });
      return { ...turnResult, sessionId: sessionReadyId };
    };
    const controller = new TurnsController(
      { execute } as ExecuteTurn,
      defaultExcelResourcePathResolver,
      new SubscribeTurnStream(hub),
    );
    const request = new EventEmitter() as Request;
    const response = new FakeResponse();

    await controller.streamTurn({ message: 'hello' }, request, response as unknown as Response);

    expect(response.headers).toMatchObject({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    expect(response.chunks.join('')).toBe(
      [
        `id: 0\nevent: turn_started\ndata: ${JSON.stringify(hubEvent(0, { type: 'turn_started' }))}\n\n`,
        `id: 1\nevent: assistant_text_delta\ndata: ${JSON.stringify(hubEvent(1, { type: 'assistant_text_delta', delta: 'hello' }))}\n\n`,
        `id: 2\nevent: tool_started\ndata: ${JSON.stringify(hubEvent(2, { type: 'tool_started', callId: 'call-1', name: 'lookup' }))}\n\n`,
        `id: 3\nevent: turn_completed\ndata: ${JSON.stringify(hubEvent(3, { type: 'turn_completed', resultLeafId: 'leaf-1' }))}\n\n`,
      ].join(''),
    );
    expect(response.writableEnded).toBe(true);
    expect(request.listenerCount('close')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('serves the stream endpoint with SSE events and headers', async () => {
    const hub = createScriptedStreamHub([
      streamEvent({ type: 'turn_started' }, 0),
      streamEvent({ type: 'assistant_text_delta', delta: 'hello' }, 1),
      streamEvent({ type: 'turn_completed', resultLeafId: 'leaf-1' }, 2),
    ]);
    const execute: ExecuteTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'turn_ready', turnId: 'turn-1' });
      return { ...turnResult, sessionId: sessionReadyId };
    };
    const server = await startServer(execute, defaultExcelResourcePathResolver, hub);
    app = server.app;

    const response = await postJson(server.port, '/turns/stream', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.body).toContain('id: 0\nevent: turn_started\ndata:');
    expect(response.body).toContain('id: 1\nevent: assistant_text_delta\ndata:');
    expect(response.body).toContain('id: 2\nevent: turn_completed\ndata:');
    expect(response.body).not.toContain('session_settled');
    expect(response.body).not.toContain('event: done');
  });

  it('resolves an Excel resource for the stream endpoint as well', async () => {
    const resolve = vi.fn(() => ({ id: 'file-2', filePath: '/shared/data/book.xlsx' }));
    const hub = createScriptedStreamHub([
      streamEvent({ type: 'turn_started' }, 0),
      streamEvent({ type: 'turn_completed', resultLeafId: 'leaf-1' }, 1),
    ]);
    const execute = vi.fn<ExecuteTurn['execute']>(async (input, options) => {
      expect(input.excelResource).toEqual({ id: 'file-2', filePath: '/shared/data/book.xlsx' });
      options?.onEvent?.({ type: 'turn_ready', turnId: 'turn-1' });
      return turnResult;
    });
    const server = await startServer(execute, { resolve }, hub);
    app = server.app;

    const response = await postJson(server.port, '/turns/stream', {
      message: 'inspect workbook',
      excelResource: { id: 'file-2', storagePath: 'data/book.xlsx' },
    });

    expect(response.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ id: 'file-2', storagePath: 'data/book.xlsx' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('sends a safe Hub terminal failure event without leaking provider details', async () => {
    const hub = createScriptedStreamHub([
      streamEvent({ type: 'turn_started' }, 0),
      streamEvent({ type: 'turn_failed', message: 'Turn failed.' }, 1),
    ]);
    const execute: ExecuteTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'turn_ready', turnId: 'turn-1' });
      return createTurnResult('error', 'provider secret');
    };
    const server = await startServer(execute, defaultExcelResourcePathResolver, hub);
    app = server.app;

    const response = await postJson(server.port, '/turns/stream', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('event: turn_failed\ndata:');
    expect(response.body).not.toContain('provider secret');
  });

  it('delegates a stream error before the first event to the API exception filter', async () => {
    const execute: ExecuteTurn['execute'] = async () => {
      throw new Error('provider secret');
    };
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/turns/stream', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
    });
    expect(response.body).not.toContain('provider secret');
  });

  it('disconnects a Hub subscriber without cancelling the execution', async () => {
    const request = new EventEmitter() as Request;
    const response = new FakeResponse();
    let returned = false;
    const hub = createBlockingStreamHub(() => {
      returned = true;
    });
    const execute: ExecuteTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'turn_ready', turnId: 'turn-1' });
      await new Promise<void>(() => undefined);
      return turnResult;
    };
    const controller = new TurnsController(
      { execute } as ExecuteTurn,
      defaultExcelResourcePathResolver,
      new SubscribeTurnStream(hub),
    );

    const operation = controller.streamTurn(
      { message: 'hello' },
      request,
      response as unknown as Response,
    );
    await Promise.resolve();
    response.emit('close');
    await operation;

    expect(returned).toBe(true);
    expect(request.listenerCount('close')).toBe(0);
  });
});

async function startServer(
  execute: ExecuteTurn['execute'],
  excelResourcePathResolver: ExcelResourcePathResolver = defaultExcelResourcePathResolver,
  streamHub: TurnStreamHub = createScriptedStreamHub([]),
): Promise<{
  readonly app: INestApplication;
  readonly port: number;
}> {
  const module = await Test.createTestingModule({
    imports: [
      ApiModule.register({
        providers: [
          { provide: ExecuteTurn, useValue: { execute } },
          {
            provide: GetSessionHistory,
            useValue: { execute: () => ({ leafId: null, items: [] }) },
          },
          { provide: EXCEL_RESOURCE_PATH_RESOLVER, useValue: excelResourcePathResolver },
          { provide: GetActiveTurn, useValue: new GetActiveTurn(streamHub) },
          { provide: SubscribeTurnStream, useValue: new SubscribeTurnStream(streamHub) },
        ],
        exports: [
          ExecuteTurn,
          GetSessionHistory,
          GetActiveTurn,
          SubscribeTurnStream,
          EXCEL_RESOURCE_PATH_RESOLVER,
        ],
      }),
    ],
  }).compile();

  const testApp = module.createNestApplication({ bodyParser: false });
  await testApp.init();
  await testApp.listen(0, '127.0.0.1');

  const address = testApp.getHttpServer().address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }
  return { app: testApp, port: address.port };
}

function postJson(port: number, path: string, body: unknown): Promise<HttpResponse> {
  return postBody(port, path, JSON.stringify(body));
}

function postBody(port: number, path: string, body: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: chunks.join(''),
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

function createScriptedStreamHub(events: readonly TurnStreamEvent[]): TurnStreamHub {
  return {
    subscribe: () => ({
      [Symbol.asyncIterator](): AsyncIterator<TurnStreamEvent> {
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

function createBlockingStreamHub(onReturn: () => void): TurnStreamHub {
  let resolveNext!: (result: IteratorResult<TurnStreamEvent>) => void;
  return {
    subscribe: () => ({
      [Symbol.asyncIterator](): AsyncIterator<TurnStreamEvent> {
        return {
          next: () =>
            new Promise<IteratorResult<TurnStreamEvent>>((resolve) => {
              resolveNext = resolve;
            }),
          return: async () => {
            onReturn();
            resolveNext?.({ value: undefined, done: true });
            return { value: undefined, done: true };
          },
        };
      },
    }),
  } as unknown as TurnStreamHub;
}

function streamEvent(payload: TurnStreamEventDraftPayload, sequence: number): TurnStreamEvent {
  return {
    ...payload,
    turnId: 'turn-1',
    sessionId: sessionReadyId,
    sequence,
    timestamp: new Date(sequence * 1_000).toISOString(),
  } as TurnStreamEvent;
}

function hubEvent(sequence: number, payload: TurnStreamEventDraftPayload): TurnStreamEvent {
  return streamEvent(payload, sequence);
}

function createTurnResult(
  finishReason: 'stop' | 'error' | 'aborted',
  errorMessage?: string,
): ExecuteTurnResult {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    leafId: 'leaf-1',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      },
      {
        role: 'assistant',
        api: 'test-api',
        provider: 'test-provider',
        model: 'test-model',
        content: finishReason === 'stop' ? [{ type: 'text', text: 'hello back' }] : [],
        finishReason,
        ...(errorMessage === undefined ? {} : { errorMessage }),
      },
    ],
  };
}
