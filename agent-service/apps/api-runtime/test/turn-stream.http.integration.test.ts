import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';

import {
  ExecuteTurn,
  GetActiveTurn,
  GetSessionHistory,
  SubscribeTurnStream,
  type ExecuteTurnResult,
  type TurnStreamHub,
} from '@opspilot/application';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { InMemoryTurnStreamHub } from '@opspilot/infrastructure';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApiModule,
  EXCEL_RESOURCE_PATH_RESOLVER,
  type ExcelResourcePathResolver,
} from '@opspilot/api';

const sessionId = '00000000-0000-4000-8000-000000000001';
const identity = { turnId: 'turn-http-1', sessionId };
const input = { message: 'hello' };

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface PendingHttpResponse {
  readonly request: ClientRequest;
  readonly response: Promise<StreamingHttpResponse>;
}

interface StreamingHttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Promise<string>;
  readonly response: IncomingMessage;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

describe('Turn stream HTTP integration', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('keeps POST SSE alive after the request body completes', async () => {
    const hub = new InMemoryTurnStreamHub();
    const executionStarted = createDeferred<void>();
    const releaseExecution = createDeferred<void>();
    const execute = vi.fn(async (_request, options): Promise<ExecuteTurnResult> => {
      openTurnForTest(hub);
      await options?.onEvent?.({ type: 'turn_ready', turnId: identity.turnId });
      executionStarted.resolve(undefined);
      await releaseExecution.promise;
      return result();
    });
    const server = await startServer(execute, hub);
    app = server.app;

    const pending = startRequest(server.port, `/sessions/${sessionId}/turns/stream`, 'POST', input);
    await executionStarted.promise;

    hub.publish({ type: 'assistant_text_delta', delta: 'still live', ...identity });
    hub.publish({ type: 'turn_completed', resultLeafId: null, ...identity });
    releaseExecution.resolve(undefined);

    const response = await pending.response;
    const body = await response.body;
    expect(response.statusCode).toBe(200);
    expect(body).toContain('event: assistant_text_delta');
    expect(body).toContain('still live');
    expect(body).toContain('event: turn_completed');
  });

  it('disconnects only the first subscriber while execution and active-turn continue', async () => {
    const hub = new InMemoryTurnStreamHub();
    const executionStarted = createDeferred<void>();
    const releaseExecution = createDeferred<void>();
    let executionSettled = false;
    const execute = vi.fn(async (_request, options): Promise<ExecuteTurnResult> => {
      openTurnForTest(hub);
      await options?.onEvent?.({ type: 'turn_ready', turnId: identity.turnId });
      executionStarted.resolve(undefined);
      await releaseExecution.promise;
      executionSettled = true;
      return result();
    });
    const server = await startServer(execute, hub);
    app = server.app;

    const first = startRequest(server.port, '/turns/stream', 'POST', input);
    await executionStarted.promise;
    const firstResponse = await first.response;
    first.request.destroy();
    await waitForTurnTick();

    expect(executionSettled).toBe(false);
    expect(hub.getActiveTurn(sessionId)).toMatchObject({ status: 'running' });

    hub.publish({ type: 'assistant_text_delta', delta: 'after disconnect', ...identity });
    hub.publish({ type: 'tool_started', callId: 'call-1', name: 'lookup', ...identity });
    expect(hub.getProjection(identity.turnId)).toMatchObject({
      assistant: { text: 'after disconnect' },
      tools: [{ callId: 'call-1', status: 'running' }],
    });

    const activeResponse = await getJson(server.port, `/sessions/${sessionId}/active-turn`);
    expect(activeResponse.statusCode).toBe(200);
    expect(JSON.parse(activeResponse.body)).toMatchObject({
      activeTurn: {
        status: 'running',
        projection: {
          assistant: { text: 'after disconnect' },
          tools: [{ callId: 'call-1', status: 'running' }],
        },
      },
    });

    const after = hub.getProjection(identity.turnId)?.lastSequence;
    expect(after).toBe(2);
    const reattached = startRequest(
      server.port,
      `/turns/${identity.turnId}/stream?after=${after}`,
      'GET',
    );
    await waitForTurnTick();
    hub.publish({ type: 'assistant_text_delta', delta: 'reattached', ...identity });
    const reattachedResponse = await reattached.response;
    const reattachedBody = reattachedResponse.body;
    hub.publish({ type: 'turn_completed', resultLeafId: null, ...identity });
    const body = await reattachedBody;

    expect(reattachedResponse.statusCode).toBe(200);
    expect(body).toContain('event: assistant_text_delta');
    expect(body).toContain('reattached');
    expect(execute).toHaveBeenCalledOnce();

    releaseExecution.resolve(undefined);
    await waitForTurnTick();
    expect(executionSettled).toBe(true);
    void firstResponse.body;
  });

  it('replays events after the requested sequence before following live events', async () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    for (const delta of ['0', '1', '2', '3', '4']) {
      hub.publish({ type: 'assistant_text_delta', delta, ...identity });
    }
    const server = await startServer(
      vi.fn<ExecuteTurn['execute']>(async () => result()),
      hub,
    );
    app = server.app;

    const pending = startRequest(server.port, `/turns/${identity.turnId}/stream?after=2`, 'GET');
    const response = await pending.response;
    const bodyPromise = response.body;
    hub.publish({ type: 'assistant_text_delta', delta: '5', ...identity });
    hub.publish({ type: 'turn_completed', resultLeafId: null, ...identity });
    const body = await bodyPromise;

    expect(response.statusCode).toBe(200);
    expect(sequenceIds(body)).toEqual([3, 4, 5, 6]);
  });

  it('returns a replay gap as the unified HTTP 409 contract', async () => {
    const hub = new InMemoryTurnStreamHub({ replayCapacity: 3 });
    hub.openTurn(identity);
    for (const delta of ['0', '1', '2', '3', '4']) {
      hub.publish({ type: 'assistant_text_delta', delta, ...identity });
    }
    const server = await startServer(
      vi.fn<ExecuteTurn['execute']>(async () => result()),
      hub,
    );
    app = server.app;

    const response = await getJson(server.port, `/turns/${identity.turnId}/stream?after=0`);
    expect(response.statusCode).toBe(409);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'TURN_STREAM_REPLAY_GAP',
      details: {
        requestedAfter: ['0'],
        oldestAvailable: ['2'],
        latestAvailable: ['4'],
      },
    });
  });

  it('returns 404 for a Turn that cannot be reattached and never starts execution', async () => {
    const hub = new InMemoryTurnStreamHub();
    const execute = vi.fn<ExecuteTurn['execute']>(async () => result());
    const server = await startServer(execute, hub);
    app = server.app;

    const response = await getJson(server.port, '/turns/missing-turn/stream');
    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'NOT_FOUND' });

    const closedTurn = { turnId: 'closed-turn', sessionId };
    hub.openTurn(closedTurn);
    hub.publish({ type: 'turn_completed', resultLeafId: null, ...closedTurn });
    const closedResponse = await getJson(server.port, '/turns/closed-turn/stream');
    expect(closedResponse.statusCode).toBe(404);
    expect(JSON.parse(closedResponse.body)).toMatchObject({ code: 'NOT_FOUND' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns active-turn null when the live Hub has no channel', async () => {
    const hub = new InMemoryTurnStreamHub();
    const server = await startServer(
      vi.fn<ExecuteTurn['execute']>(async () => result()),
      hub,
    );
    app = server.app;

    const response = await getJson(server.port, `/sessions/${sessionId}/active-turn`);
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ activeTurn: null });
  });

  it('delivers a terminal event before closing a real HTTP SSE connection', async () => {
    const hub = new InMemoryTurnStreamHub();
    hub.openTurn(identity);
    hub.publish({ type: 'turn_started', ...identity });
    const server = await startServer(
      vi.fn<ExecuteTurn['execute']>(async () => result()),
      hub,
    );
    app = server.app;

    const pending = startRequest(server.port, `/turns/${identity.turnId}/stream`, 'GET');
    const response = await pending.response;
    const bodyPromise = response.body;
    hub.publish({ type: 'assistant_text_delta', delta: 'answer', ...identity });
    hub.publish({ type: 'turn_completed', resultLeafId: null, ...identity });
    const body = await bodyPromise;

    expect(response.statusCode).toBe(200);
    expect(body.indexOf('event: assistant_text_delta')).toBeLessThan(
      body.indexOf('event: turn_completed'),
    );
    expect(hub.getActiveTurn(sessionId)).toBeNull();
  });
});

async function startServer(
  execute: ExecuteTurn['execute'],
  streamHub: TurnStreamHub,
): Promise<{ readonly app: INestApplication; readonly port: number }> {
  const module = await Test.createTestingModule({
    imports: [
      ApiModule.register({
        providers: [
          { provide: ExecuteTurn, useValue: { execute } },
          {
            provide: GetSessionHistory,
            useValue: { execute: () => ({ leafId: null, items: [] }) },
          },
          {
            provide: EXCEL_RESOURCE_PATH_RESOLVER,
            useValue: {
              resolve: (resource) => ({ id: resource.id, filePath: resource.storagePath }),
            } satisfies ExcelResourcePathResolver,
          },
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

function openTurnForTest(hub: InMemoryTurnStreamHub): void {
  hub.openTurn(identity);
  hub.publish({ type: 'turn_started', ...identity });
}

function result(): ExecuteTurnResult {
  return { sessionId, turnId: identity.turnId, leafId: null, messages: [] };
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function startRequest(
  port: number,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): PendingHttpResponse {
  let responseStarted = false;
  let resolveResponse!: (response: StreamingHttpResponse) => void;
  let rejectResponse!: (error: Error) => void;
  const response = new Promise<StreamingHttpResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });
  const request = httpRequest(
    {
      host: '127.0.0.1',
      port,
      path,
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' } }),
    },
    (incomingResponse) => {
      responseStarted = true;
      const chunks: string[] = [];
      incomingResponse.setEncoding('utf8');
      const bodyPromise = new Promise<string>((resolve) => {
        incomingResponse.on('data', (chunk: string) => chunks.push(chunk));
        incomingResponse.on('end', () => resolve(chunks.join('')));
        incomingResponse.on('close', () => resolve(chunks.join('')));
        incomingResponse.on('error', () => resolve(chunks.join('')));
      });
      resolveResponse({
        statusCode: incomingResponse.statusCode ?? 0,
        headers: incomingResponse.headers,
        body: bodyPromise,
        response: incomingResponse,
      });
    },
  );
  request.on('error', (error: Error) => {
    if (!responseStarted) rejectResponse(error);
  });
  if (body === undefined) request.end();
  else request.end(JSON.stringify(body));
  return { request, response };
}

function getJson(port: number, path: string): Promise<HttpResponse> {
  const pending = startRequest(port, path, 'GET');
  return pending.response.then(async (response) => ({
    statusCode: response.statusCode,
    headers: response.headers,
    body: await response.body,
  }));
}

function sequenceIds(body: string): number[] {
  return [...body.matchAll(/id: (\d+)\n/g)].map((match) => Number(match[1]));
}

async function waitForTurnTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
