import type { CreateIncidentFromAlert } from '@opspilot/application';
import { describe, expect, it, vi } from 'vitest';

import { AlertsController } from '../src/alerts/alerts.controller.js';

const requestId = '0d9ef0c6-ce1b-4906-b472-83e651731e88';
const incidentId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const body = {
  title: 'Do not log this title',
  source: 'prometheus',
  severity: 'critical' as const,
  triggeredAt: '2026-08-12T09:00:00.000Z',
  service: 'billing-api',
  summary: 'Do not log this summary',
  labels: { token: 'must-not-log' },
};

describe('AlertsController audit logging', () => {
  it('logs a safe successful audit summary and forwards the request ID to the use case', async () => {
    const execute = vi.fn(async () => ({
      incident: { id: incidentId, status: 'OPEN' as const, createdAt: '2026-08-12T09:00:00.000Z' },
      run: { id: runId, incidentId, status: 'QUEUED' as const, createdAt: '2026-08-12T09:00:00.000Z' },
    }));
    const records: Record<string, unknown>[] = [];
    const controller = new AlertsController(
      { execute } as CreateIncidentFromAlert,
      { info: (record: Record<string, unknown>) => records.push(record) } as never,
    );
    const headers: Record<string, string> = {};

    const result = await controller.create(
      body,
      'idempotency-key-secret',
      { requestId } as never,
      { setHeader: (name: string, value: string) => (headers[name] = value) } as never,
    );

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ requestId }));
    expect(headers['X-Request-Id']).toBe(requestId);
    expect(result.requestId).toBe(requestId);
    expect(records).toEqual([
      expect.objectContaining({
        event: 'alert.received',
        requestId,
        source: 'prometheus',
        outcome: 'succeeded',
        incidentId,
        runId,
        idempotencyKeyHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('idempotency-key-secret');
    expect(JSON.stringify(records)).not.toContain('Do not log');
    expect(JSON.stringify(records)).not.toContain('must-not-log');
  });
});
