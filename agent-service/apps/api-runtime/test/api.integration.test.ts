import { afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL = 'silent';
});

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { DatabaseRepositoryContainer } from '@opspilot/db';
import { createRepositories } from '@opspilot/db';
import { prisma } from '@opspilot/db/testing';
import request from 'supertest';

import { createApiRuntimeModule } from '../src/runtime-module.js';

const rollback = new Error('rollback API integration test transaction');
const requestId = '33333333-3333-4333-8333-333333333333';
const alert = {
  title: 'Connection pool exhausted',
  source: 'integration-test',
  severity: 'critical',
  triggeredAt: '2026-08-12T11:00:00.000Z',
  service: 'billing-api',
  summary: 'Database connections are exhausted.',
  labels: { environment: 'test' },
};

afterAll(async () => {
  await prisma.$disconnect();
});

async function inRollbackApiTransaction(run: (app: INestApplication) => Promise<void>): Promise<void> {
  await expect(
    prisma.$transaction(async (transaction) => {
      const repositories: DatabaseRepositoryContainer = {
        ...createRepositories(transaction),
        disconnect: async () => undefined,
      };
      const app = await NestFactory.create(createApiRuntimeModule(repositories), {
        bodyParser: false,
        logger: false,
      });
      await app.init();
      try {
        await run(app);
      } finally {
        await app.close();
      }
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

describe('API runtime HTTP integration', () => {
  it('creates and retrieves an incident without retaining test records after rollback', async () => {
    await inRollbackApiTransaction(async (app) => {
      const server = app.getHttpServer();
      const created = await request(server)
        .post('/alerts')
        .set('X-Request-Id', requestId)
        .set('Idempotency-Key', 'api-integration-idempotency-key')
        .send(alert)
        .expect(201);

      expect(created.headers['x-request-id']).toBe(requestId);
      expect(created.body).toMatchObject({
        incidentStatus: 'OPEN',
        runStatus: 'QUEUED',
        requestId,
      });

      const replayed = await request(server)
        .post('/alerts')
        .set('Idempotency-Key', 'api-integration-idempotency-key')
        .send(alert)
        .expect(201);
      expect(replayed.body.incidentId).toBe(created.body.incidentId);
      expect(replayed.body.runId).toBe(created.body.runId);

      const detail = await request(server)
        .get(`/incidents/${created.body.incidentId}`)
        .set('X-Request-Id', requestId)
        .expect(200);
      expect(detail.headers['x-request-id']).toBe(requestId);
      expect(detail.body.incident).toMatchObject({ id: created.body.incidentId, status: 'OPEN' });
      expect(detail.body.runs).toEqual([
        expect.objectContaining({ id: created.body.runId, status: 'QUEUED' }),
      ]);
      expect(detail.body.timeline).toHaveLength(1);
      expect(detail.body.timeline[0]).toMatchObject({ type: 'alert.received' });
      expect(detail.body.timeline[0].payload).toEqual({
        title: alert.title,
        source: alert.source,
        severity: alert.severity,
        triggeredAt: alert.triggeredAt,
        service: alert.service,
        summary: alert.summary,
      });
    });
  });

  it('returns standardized 400 and 404 errors with the request ID', async () => {
    await inRollbackApiTransaction(async (app) => {
      const server = app.getHttpServer();
      const invalidAlert = await request(server)
        .post('/alerts')
        .set('X-Request-Id', requestId)
        .send({ source: 'integration-test' })
        .expect(400);
      expectError(invalidAlert, 400, 'VALIDATION_ERROR', requestId);

      const invalidId = await request(server)
        .get('/incidents/not-a-uuid')
        .set('X-Request-Id', requestId)
        .expect(400);
      expectError(invalidId, 400, 'VALIDATION_ERROR', requestId);

      const notFound = await request(server)
        .get('/incidents/44444444-4444-4444-8444-444444444444')
        .set('X-Request-Id', requestId)
        .expect(404);
      expectError(notFound, 404, 'NOT_FOUND', requestId);
    });
  });

  it('returns a safe standardized 500 for an unexpected use-case error', async () => {
    const repositories = {
      incidents: {
        findById: async () => ({
          id: '55555555-5555-4555-8555-555555555555',
          status: 'OPEN' as const,
          createdAt: '2026-08-12T11:00:00.000Z',
        }),
        listRuns: async () => [],
      },
      analysisRuns: {
        listEvents: async () => {
          throw new Error('database password must-not-leak');
        },
      },
      alertReceipts: {},
      evidence: {},
      actions: {},
      disconnect: async () => undefined,
    } as unknown as DatabaseRepositoryContainer;
    const app = await NestFactory.create(createApiRuntimeModule(repositories), {
      bodyParser: false,
      logger: false,
    });
    await app.init();
    try {
      const response = await request(app.getHttpServer())
        .get('/incidents/55555555-5555-4555-8555-555555555555')
        .set('X-Request-Id', requestId)
        .expect(500);
      expectError(response, 500, 'INTERNAL_ERROR', requestId);
      expect(JSON.stringify(response.body)).not.toContain('must-not-leak');
    } finally {
      await app.close();
    }
  });
});

function expectError(
  response: request.Response,
  statusCode: number,
  code: string,
  expectedRequestId: string,
): void {
  expect(response.headers['x-request-id']).toBe(expectedRequestId);
  expect(response.body).toMatchObject({
    statusCode,
    code,
    requestId: expectedRequestId,
    timestamp: expect.any(String),
  });
}
