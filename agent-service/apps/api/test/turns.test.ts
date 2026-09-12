import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { EventEmitter } from 'node:events';

import {
  ExecuteTurn,
  GetActiveTurn,
  GetSessionHistory,
  GetTurnTrace,
  TurnNotFoundError,
  SubscribeTurnStream,
  type TurnState,
  type TurnEvent,
  type TurnStore,
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

  it('returns the durable completed TurnTrace projection', async () => {
    const server = await startServer(
      unusedExecute(),
      defaultExcelResourcePathResolver,
      createScriptedStreamHub([]),
      createTraceQuery([
        traceTurnStarted(0),
        traceModelStarted(1, 'model-call-A'),
        traceModelCompleted(2, 'model-call-A'),
        traceUsage(3, 'model-call-A'),
        traceToolRequested(4, 'tool-call-X', 'lookup'),
        traceToolStarted(5, 'tool-call-X', 'lookup'),
        traceToolCompleted(6, 'tool-call-X', 'lookup', false),
        traceModelStarted(7, 'model-call-B'),
        traceModelCompleted(8, 'model-call-B'),
        traceTurnCompleted(9),
      ]),
    );
    app = server.app;

    const response = await getJson(server.port, '/turns/turn-trace-1/trace');
    const trace = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(trace).toMatchObject({
      turnId: 'turn-trace-1',
      sessionId: 'session-trace-1',
      status: 'completed',
    });
    expect(trace.spans.map((span: { readonly kind: string }) => span.kind)).toEqual([
      'model',
      'tool',
      'model',
    ]);
    expect(trace.spans[0]).toMatchObject({
      modelCallId: 'model-call-A',
      status: 'completed',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
    expect(trace.spans[1]).toMatchObject({
      callId: 'tool-call-X',
      name: 'lookup',
      status: 'completed',
      durationMs: 1_000,
    });
    expect(trace.spans[2]).toMatchObject({
      modelCallId: 'model-call-B',
      status: 'completed',
    });
  });

  it('returns a running Trace with an incomplete model span', async () => {
    const server = await startServer(
      unusedExecute(),
      defaultExcelResourcePathResolver,
      createScriptedStreamHub([]),
      createTraceQuery([traceTurnStarted(0), traceModelStarted(1, 'model-call-A')]),
    );
    app = server.app;

    const response = await getJson(server.port, '/turns/turn-trace-1/trace');
    const trace = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(trace.status).toBe('running');
    expect(trace.spans[0]).toMatchObject({
      modelCallId: 'model-call-A',
      status: 'incomplete',
      endedAt: null,
      durationMs: null,
    });
  });

  it.each([
    ['failed', traceTurnFailed(2, 'provider failed')],
    ['cancelled', traceTurnCancelled(2)],
  ] as const)('returns HTTP 200 for a %s Turn', async (status, terminalEvent) => {
    const server = await startServer(
      unusedExecute(),
      defaultExcelResourcePathResolver,
      createScriptedStreamHub([]),
      createTraceQuery([traceTurnStarted(0), traceModelStarted(1, 'model-call-A'), terminalEvent]),
    );
    app = server.app;

    const response = await getJson(server.port, '/turns/turn-trace-1/trace');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe(status);
  });

  it('returns separate recovery attempt spans through the query boundary', async () => {
    const server = await startServer(
      unusedExecute(),
      defaultExcelResourcePathResolver,
      createScriptedStreamHub([]),
      createTraceQuery([
        traceTurnStarted(0, 1),
        traceModelStarted(1, 'model-call-A', 1),
        traceToolRequested(2, 'tool-call-X', 'lookup', 1),
        traceToolStarted(3, 'tool-call-X', 'lookup', 1),
        traceTurnResumed(4, 2),
        traceModelStarted(5, 'model-call-B', 2),
        traceModelCompleted(6, 'model-call-B', 2),
        traceToolStarted(7, 'tool-call-X', 'lookup', 2),
        traceToolCompleted(8, 'tool-call-X', 'lookup', false, 2),
      ]),
    );
    app = server.app;

    const response = await getJson(server.port, '/turns/turn-trace-1/trace');
    const trace = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(trace.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'model:model-call-A',
          attempt: 1,
          status: 'incomplete',
        }),
        expect.objectContaining({
          id: 'tool:tool-call-X:attempt:1',
          attempt: 1,
          status: 'incomplete',
        }),
        expect.objectContaining({
          id: 'model:model-call-B',
          attempt: 2,
          status: 'completed',
        }),
        expect.objectContaining({
          id: 'tool:tool-call-X:attempt:2',
          attempt: 2,
          status: 'completed',
          requestedAt: null,
        }),
      ]),
    );
  });

  it('returns 404 instead of an empty Trace when the Turn does not exist', async () => {
    const server = await startServer(
      unusedExecute(),
      defaultExcelResourcePathResolver,
      createScriptedStreamHub([]),
      createNotFoundTraceQuery('missing-turn'),
    );
    app = server.app;

    const response = await getJson(server.port, '/turns/missing-turn/trace');

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'NOT_FOUND' });
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
      unusedTurnTraceQuery(),
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
      unusedTurnTraceQuery(),
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
  getTurnTrace: GetTurnTrace = unusedTurnTraceQuery(),
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
          { provide: GetTurnTrace, useValue: getTurnTrace },
        ],
        exports: [
          ExecuteTurn,
          GetSessionHistory,
          GetActiveTurn,
          SubscribeTurnStream,
          GetTurnTrace,
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

function unusedTurnTraceQuery(): GetTurnTrace {
  return {
    execute: () => {
      throw new Error('GetTurnTrace is not used by this test.');
    },
  } as unknown as GetTurnTrace;
}

function unusedExecute(): ExecuteTurn['execute'] {
  return async () => turnResult;
}

function createTraceQuery(events: readonly TurnEvent[]): GetTurnTrace {
  const state = createTraceTurnState();
  const storedTurn = { getState: () => state } as unknown as ReturnType<TurnStore['load']>;
  const turnStore = {
    load: () => storedTurn,
    loadEvents: () => events,
  } as unknown as TurnStore;
  return new GetTurnTrace({ turnStore });
}

function createNotFoundTraceQuery(turnId: string): GetTurnTrace {
  const turnStore = {
    load: () => {
      throw new TurnNotFoundError(turnId);
    },
  } as unknown as TurnStore;
  return new GetTurnTrace({ turnStore });
}

function createTraceTurnState(): TurnState {
  return {
    id: 'turn-trace-1',
    sessionId: 'session-trace-1',
    status: 'running',
    baseLeafId: null,
    inputEntryId: null,
    resultLeafId: null,
    attempt: 1,
    checkpoint: null,
    createdAt: timestamp(0),
    startedAt: timestamp(0),
    completedAt: null,
  };
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

function getJson(port: number, path: string): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { accept: 'application/json' },
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
    request.end();
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

function traceTurnStarted(sequence: number, attempt = 1): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'turn_started' };
}

function traceTurnResumed(sequence: number, attempt: number): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'turn_resumed' };
}

function traceTurnCompleted(sequence: number, attempt = 1): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'turn_completed', resultLeafId: null };
}

function traceTurnFailed(sequence: number, message: string, attempt = 1): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'turn_failed', message };
}

function traceTurnCancelled(sequence: number, attempt = 1): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'turn_cancelled' };
}

function traceModelStarted(sequence: number, modelCallId: string, attempt = 1): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'model_started', modelCallId };
}

function traceModelCompleted(sequence: number, modelCallId: string, attempt = 1): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'model_completed', modelCallId };
}

function traceUsage(sequence: number, modelCallId: string, attempt = 1): TurnEvent {
  return {
    ...traceBaseEvent(sequence, attempt),
    type: 'usage_recorded',
    modelCallId,
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  };
}

function traceToolRequested(
  sequence: number,
  callId: string,
  name: string,
  attempt = 1,
): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'tool_requested', callId, name };
}

function traceToolStarted(sequence: number, callId: string, name: string, attempt = 1): TurnEvent {
  return { ...traceBaseEvent(sequence, attempt), type: 'tool_started', callId, name };
}

function traceToolCompleted(
  sequence: number,
  callId: string,
  name: string,
  isError: boolean,
  attempt = 1,
): TurnEvent {
  return {
    ...traceBaseEvent(sequence, attempt),
    type: 'tool_completed',
    callId,
    name,
    isError,
    resultEntryId: `result-${callId}-${attempt}`,
    sessionLeafId: `leaf-${callId}-${attempt}`,
  };
}

function traceBaseEvent(sequence: number, attempt: number): Omit<TurnEvent, 'type'> {
  return {
    version: 2,
    id: `trace-event-${sequence}-${attempt}`,
    turnId: 'turn-trace-1',
    sessionId: 'session-trace-1',
    sequence,
    attempt,
    timestamp: timestamp(sequence),
  };
}

function timestamp(sequence: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString();
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
