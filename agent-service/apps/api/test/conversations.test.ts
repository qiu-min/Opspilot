import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { EventEmitter } from 'node:events';

import { RunConversationTurn } from '@opspilot/application';
import type { RunConversationTurnInput, RunConversationTurnResult } from '@opspilot/application';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiModule, EXCEL_RESOURCE_PATH_RESOLVER } from '../src/index.js';
import { ConversationsController } from '../src/conversations/conversations.controller.js';
import type { ExcelResourcePathResolver } from '../src/conversations/excel-resource-path-resolver.js';

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
const defaultExcelResourcePathResolver: ExcelResourcePathResolver = {
  resolve(resource) {
    return { id: resource.id, filePath: resource.storagePath };
  },
};

describe('Conversation API', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('runs a JSON turn, maps the user string, and returns the public result', async () => {
    const execute = vi.fn<RunConversationTurn['execute']>(async (input) => {
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

    const response = await postJson(server.port, '/conversations/turns', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      sessionId: 'session-1',
      leafId: 'leaf-1',
      status: 'completed',
      output: 'hello back',
    });
    expect(execute.mock.calls[0]).toHaveLength(1);
  });

  it('resolves an Excel resource without exposing its file path to the request contract', async () => {
    const resolve = vi.fn(() => ({ id: 'file-1', filePath: '/shared/uploads/report.xlsx' }));
    const execute = vi.fn<RunConversationTurn['execute']>(async (input) => {
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

    const response = await postJson(server.port, '/conversations/turns', {
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
    const execute = vi.fn<RunConversationTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/conversations/turns', {
      message: 'inspect workbook',
      excelResource,
      ...(filePath === undefined ? {} : { filePath }),
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an invalid JSON turn body', async () => {
    const execute = vi.fn<RunConversationTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postBody(server.port, '/conversations/turns', '{not-json');

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Invalid JSON body.',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('continues an empty body request without hanging', async () => {
    const execute = vi.fn<RunConversationTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postBody(server.port, '/conversations/turns', '');

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
      const execute = vi.fn<RunConversationTurn['execute']>(async () =>
        createTurnResult(finishReason, 'provider secret'),
      );
      const server = await startServer(execute);
      app = server.app;

      const response = await postJson(server.port, '/conversations/turns', {
        message: 'hello',
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({
        sessionId: 'session-1',
        leafId: 'leaf-1',
        status,
        output: '',
      });
      expect(response.body).not.toContain('provider secret');
    },
  );

  it('rejects a non-v4 sessionId before calling Application', async () => {
    const execute = vi.fn<RunConversationTurn['execute']>(async () => turnResult);
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/conversations/turns', {
      sessionId: 'abc',
      message: 'hello',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('writes AgentEvents in order, forwards tool events, and sends done', async () => {
    const execute: RunConversationTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'agent_start' });
      options?.onEvent?.({
        type: 'tool_execution_start',
        toolCall: { callId: 'call-1', name: 'lookup', arguments: { query: 'hello' } },
      });
      return turnResult;
    };
    const controller = new ConversationsController(
      { execute } as RunConversationTurn,
      defaultExcelResourcePathResolver,
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
        'event: agent_start\ndata: {"type":"agent_start"}\n\n',
        'event: tool_execution_start\ndata: {"type":"tool_execution_start","toolCall":{"callId":"call-1","name":"lookup","arguments":{"query":"hello"}}}\n\n',
        'event: done\ndata: {"sessionId":"session-1","leafId":"leaf-1","status":"completed"}\n\n',
      ].join(''),
    );
    expect(response.writableEnded).toBe(true);
    expect(request.listenerCount('close')).toBe(0);
    expect(response.listenerCount('close')).toBe(0);
  });

  it('serves the stream endpoint with SSE events and headers', async () => {
    const execute: RunConversationTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'agent_start' });
      return turnResult;
    };
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/conversations/turns/stream', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');
    expect(response.body).toBe(
      [
        'event: agent_start\ndata: {"type":"agent_start"}\n\n',
        'event: done\ndata: {"sessionId":"session-1","leafId":"leaf-1","status":"completed"}\n\n',
      ].join(''),
    );
  });

  it('resolves an Excel resource for the stream endpoint as well', async () => {
    const resolve = vi.fn(() => ({ id: 'file-2', filePath: '/shared/data/book.xlsx' }));
    const execute = vi.fn<RunConversationTurn['execute']>(async (input) => {
      expect(input.excelResource).toEqual({ id: 'file-2', filePath: '/shared/data/book.xlsx' });
      return turnResult;
    });
    const server = await startServer(execute, { resolve });
    app = server.app;

    const response = await postJson(server.port, '/conversations/turns/stream', {
      message: 'inspect workbook',
      excelResource: { id: 'file-2', storagePath: 'data/book.xlsx' },
    });

    expect(response.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith({ id: 'file-2', storagePath: 'data/book.xlsx' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('sanitizes Agent error events and sends done with error status', async () => {
    const errorResult = createTurnResult('error', 'provider secret');
    const execute: RunConversationTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'agent_end', messages: errorResult.messages });
      return errorResult;
    };
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/conversations/turns/stream', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain(
      'event: done\ndata: {"sessionId":"session-1","leafId":"leaf-1","status":"error"}\n\n',
    );
    expect(response.body).not.toContain('errorMessage');
    expect(response.body).not.toContain('provider secret');
  });

  it('delegates a stream error before the first event to the API exception filter', async () => {
    const execute: RunConversationTurn['execute'] = async () => {
      throw new Error('provider secret');
    };
    const server = await startServer(execute);
    app = server.app;

    const response = await postJson(server.port, '/conversations/turns/stream', {
      message: 'hello',
    });

    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
    });
    expect(response.body).not.toContain('provider secret');
  });

  it('sends an SSE error after the stream has started', async () => {
    const execute: RunConversationTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'agent_start' });
      throw new Error('provider secret');
    };
    const controller = new ConversationsController(
      { execute } as RunConversationTurn,
      defaultExcelResourcePathResolver,
    );
    const request = new EventEmitter() as Request;
    const response = new FakeResponse();

    await controller.streamTurn({ message: 'hello' }, request, response as unknown as Response);

    expect(response.chunks.join('')).toContain(
      'event: error\ndata: {"message":"Internal server error."}\n\n',
    );
    expect(response.chunks.join('')).not.toContain('provider secret');
    expect(response.writableEnded).toBe(true);
  });

  it('does not write more events after the client disconnects', async () => {
    const request = new EventEmitter() as Request;
    const response = new FakeResponse();
    const execute: RunConversationTurn['execute'] = async (_input, options) => {
      options?.onEvent?.({ type: 'agent_start' });
      request.emit('close');
      options?.onEvent?.({ type: 'agent_end', messages: turnResult.messages });
      return turnResult;
    };
    const controller = new ConversationsController(
      { execute } as RunConversationTurn,
      defaultExcelResourcePathResolver,
    );

    await controller.streamTurn({ message: 'hello' }, request, response as unknown as Response);

    expect(response.chunks.join('')).toBe('event: agent_start\ndata: {"type":"agent_start"}\n\n');
    expect(response.writableEnded).toBe(true);
  });
});

async function startServer(
  execute: RunConversationTurn['execute'],
  excelResourcePathResolver: ExcelResourcePathResolver = defaultExcelResourcePathResolver,
): Promise<{
  readonly app: INestApplication;
  readonly port: number;
}> {
  const module = await Test.createTestingModule({
    imports: [
      ApiModule.register({
        providers: [
          { provide: RunConversationTurn, useValue: { execute } },
          { provide: EXCEL_RESOURCE_PATH_RESOLVER, useValue: excelResourcePathResolver },
        ],
        exports: [RunConversationTurn, EXCEL_RESOURCE_PATH_RESOLVER],
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

function createTurnResult(
  finishReason: 'stop' | 'error' | 'aborted',
  errorMessage?: string,
): RunConversationTurnResult {
  return {
    sessionId: 'session-1',
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
