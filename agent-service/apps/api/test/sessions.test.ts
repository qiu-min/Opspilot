import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';

import {
  GetConversationHistory,
  RunConversationTurn,
  SessionManager,
  type SessionStore,
} from '@opspilot/application';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiModule, EXCEL_RESOURCE_PATH_RESOLVER } from '../src/index.js';
import type { ExcelResourcePathResolver } from '../src/conversations/excel-resource-path-resolver.js';

interface HttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

describe('Session history API', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('loads an existing session and returns only the active branch UI history', async () => {
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const session = SessionManager.inMemory({ id: sessionId });
    const user = session.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    });
    const assistant = session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [
        {
          type: 'thinking',
          thinking: 'private thinking',
          thinkingSignature: 'reasoning',
          source: { api: 'test-api', provider: 'test-provider', model: 'test-model' },
        },
        { type: 'text', text: 'hello back' },
      ],
      finishReason: 'stop',
    });
    const hiddenBranch = session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [{ type: 'text', text: 'hidden' }],
      finishReason: 'stop',
    });
    session.branch(assistant.id);
    const activeBranchReply = session.appendMessage({
      role: 'assistant',
      api: 'test-api',
      provider: 'test-provider',
      model: 'test-model',
      content: [{ type: 'text', text: 'active reply' }],
      finishReason: 'stop',
    });
    const loadCalls: string[] = [];
    const store: SessionStore = {
      create: () => {
        throw new Error('history endpoint must not create sessions');
      },
      load: (requestedSessionId) => {
        loadCalls.push(requestedSessionId);
        if (requestedSessionId !== sessionId) throw new Error('missing session');
        return session;
      },
    };
    app = await startServer(new GetConversationHistory(store));

    const response = await getJson(app, `/sessions/${sessionId}/history`);

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      leafId: string | null;
      items: Array<{ id: string; role: string; text: string; createdAt: string }>;
    };
    expect(loadCalls).toEqual([sessionId]);
    expect(body.leafId).toBe(activeBranchReply.id);
    expect(body.items.map((item) => item.id)).toEqual([
      user.id,
      assistant.id,
      activeBranchReply.id,
    ]);
    expect(body.items.map((item) => item.text)).toEqual(['hello', 'hello back', 'active reply']);
    expect(response.body).not.toContain('private thinking');
    expect(response.body).not.toContain(hiddenBranch.id);
  });
});

async function startServer(
  getConversationHistory: GetConversationHistory,
): Promise<INestApplication> {
  const module = await Test.createTestingModule({
    imports: [
      ApiModule.register({
        providers: [
          {
            provide: RunConversationTurn,
            useValue: {
              execute: async () => {
                throw new Error('not used');
              },
            },
          },
          { provide: GetConversationHistory, useValue: getConversationHistory },
          {
            provide: EXCEL_RESOURCE_PATH_RESOLVER,
            useValue: {
              resolve: (resource) => ({ id: resource.id, filePath: resource.storagePath }),
            } satisfies ExcelResourcePathResolver,
          },
        ],
        exports: [RunConversationTurn, GetConversationHistory, EXCEL_RESOURCE_PATH_RESOLVER],
      }),
    ],
  }).compile();

  const testApp = module.createNestApplication({ bodyParser: false });
  await testApp.init();
  await testApp.listen(0, '127.0.0.1');
  return testApp;
}

function getJson(app: INestApplication, path: string): Promise<HttpResponse> {
  const address = app.getHttpServer().address();
  if (address === null || typeof address === 'string') {
    throw new Error('Test server did not expose a TCP address.');
  }

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path,
        method: 'GET',
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
