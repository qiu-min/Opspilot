import { describe, expect, it } from 'vitest';

import {
  createAlertRequestSchema,
  createAlertResponseSchema,
  getIncidentDetailResponseSchema,
} from '../src/index.js';

const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
const createdAt = '2026-08-12T12:00:00.000Z';
const request = {
  title: ' Database connection pool exhausted ',
  source: ' prometheus ',
  severity: 'critical',
  triggeredAt: createdAt,
  service: ' payments-api ',
  summary: 'Database connections reached their configured limit.',
  labels: { region: 'cn-east-1', environment: 'production' },
  sourceReference: 'https://monitoring.example.test/alerts/123',
};

describe('alert DTO contracts', () => {
  it('parses and normalizes a strict alert request', () => {
    expect(createAlertRequestSchema.parse(request)).toMatchObject({
      title: 'Database connection pool exhausted',
      source: 'prometheus',
      service: 'payments-api',
    });
  });

  it.each(['title', 'source', 'severity', 'triggeredAt', 'service', 'summary'])(
    'requires %s',
    (field) => {
      const value = { ...request } as Record<string, unknown>;
      delete value[field];
      expect(createAlertRequestSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects invalid severity, datetime, labels, source references, and unknown fields', () => {
    expect(createAlertRequestSchema.safeParse({ ...request, severity: 'urgent' }).success).toBe(
      false,
    );
    expect(
      createAlertRequestSchema.safeParse({ ...request, triggeredAt: 'not-a-date' }).success,
    ).toBe(false);
    expect(
      createAlertRequestSchema.safeParse({
        ...request,
        labels: Object.fromEntries(
          Array.from({ length: 21 }, (_, index) => [`label-${index}`, 'x']),
        ),
      }).success,
    ).toBe(false);
    expect(
      createAlertRequestSchema.safeParse({ ...request, labels: { ['x'.repeat(65)]: 'value' } })
        .success,
    ).toBe(false);
    expect(
      createAlertRequestSchema.safeParse({ ...request, labels: { x: 'a'.repeat(257) } }).success,
    ).toBe(false);
    expect(
      createAlertRequestSchema.safeParse({ ...request, sourceReference: 'not-a-url' }).success,
    ).toBe(false);
    expect(createAlertRequestSchema.safeParse({ ...request, unexpected: true }).success).toBe(
      false,
    );
  });

  it('validates alert creation and incident detail responses', () => {
    expect(
      createAlertResponseSchema.safeParse({
        incidentId: id,
        runId: id,
        incidentStatus: 'OPEN',
        runStatus: 'QUEUED',
        createdAt,
        requestId: id,
      }).success,
    ).toBe(true);
    expect(
      getIncidentDetailResponseSchema.safeParse({
        incident: { id, status: 'OPEN', createdAt },
        runs: [{ id, incidentId: id, status: 'QUEUED', createdAt }],
        timeline: [
          {
            id,
            incidentId: id,
            runId: id,
            parentEventId: null,
            type: 'run.started',
            payload: {},
            schemaVersion: 1,
            createdAt,
          },
        ],
      }).success,
    ).toBe(true);
    expect(createAlertResponseSchema.safeParse({ incidentId: 'invalid' }).success).toBe(false);
    expect(
      createAlertResponseSchema.safeParse({
        incidentId: id,
        runId: id,
        incidentStatus: 'UNKNOWN',
        runStatus: 'QUEUED',
        createdAt: 'not-a-date',
        requestId: id,
      }).success,
    ).toBe(false);
    expect(
      getIncidentDetailResponseSchema.safeParse({ incident: {}, runs: [], timeline: [] }).success,
    ).toBe(false);
  });
});
