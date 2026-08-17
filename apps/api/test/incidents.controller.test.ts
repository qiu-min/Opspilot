import { IncidentNotFoundError, type GetIncidentDetail } from '@opspilot/application';
import type { IncidentDetail } from '@opspilot/application';
import { describe, expect, it, vi } from 'vitest';

import { IncidentsController } from '../src/incidents/incidents.controller.js';

const incidentId = '0d9ef0c6-ce1b-4906-b472-83e651731e88';
const runId = '28884a66-b47c-4bdf-9769-c967de991d0d';

function createDetail(): IncidentDetail {
  return {
    incident: { id: incidentId, status: 'OPEN', createdAt: '2026-08-12T00:00:00.000Z' },
    runs: [{ id: runId, incidentId, status: 'QUEUED', createdAt: '2026-08-12T00:00:00.000Z' }],
    events: [
      {
        id: '10000000-0000-4000-8000-000000000001',
        incidentId,
        runId,
        parentEventId: null,
        type: 'alert.received',
        payload: {
          title: 'Database connection pool exhausted',
          source: 'prometheus',
          severity: 'critical',
          triggeredAt: '2026-08-12T00:00:00.000Z',
          service: 'orders',
          summary: 'Pool saturation detected.',
          labels: { environment: 'production' },
          sourceReference: 'https://example.com/alerts/1',
          credential: 'must-not-leak',
        },
        schemaVersion: 1,
        createdAt: '2026-08-12T00:00:00.000Z',
      },
      {
        id: '10000000-0000-4000-8000-000000000002',
        incidentId,
        runId,
        parentEventId: null,
        type: 'run.started',
        payload: { rawLog: 'must-not-leak' },
        schemaVersion: 1,
        createdAt: '2026-08-12T00:00:01.000Z',
      },
    ],
  };
}

describe('IncidentsController', () => {
  it('returns the shared detail contract and only public event payload fields', async () => {
    const execute = vi.fn(async () => createDetail());
    const controller = new IncidentsController({ execute } as GetIncidentDetail);

    const result = await controller.findOne({ id: incidentId }, { requestId: incidentId } as never);

    expect(execute).toHaveBeenCalledWith({ incidentId, requestId: incidentId });
    expect(result.incident.status).toBe('OPEN');
    expect(result.runs).toEqual([
      { id: runId, incidentId, status: 'QUEUED', createdAt: '2026-08-12T00:00:00.000Z' },
    ]);
    expect(result.timeline[0]?.payload).toEqual({
      title: 'Database connection pool exhausted',
      source: 'prometheus',
      severity: 'critical',
      triggeredAt: '2026-08-12T00:00:00.000Z',
      service: 'orders',
      summary: 'Pool saturation detected.',
    });
    expect(result.timeline[1]?.payload).toEqual({});
  });

  it('lets a missing incident reach the global error filter', async () => {
    const execute = vi.fn(async () => {
      throw new IncidentNotFoundError(incidentId);
    });
    const controller = new IncidentsController({ execute } as GetIncidentDetail);

    await expect(
      controller.findOne({ id: incidentId }, { requestId: incidentId } as never),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });
});
