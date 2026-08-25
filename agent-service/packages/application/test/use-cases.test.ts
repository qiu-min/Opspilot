import type { AnalysisRunDto, IncidentDto, RunEvent } from '@opspilot/domain';
import { describe, expect, it } from 'vitest';

import type {
  AlertReceiptRepository,
  AnalysisRunRepository,
  IncidentRepository,
} from '../src/ports/repositories.js';
import {
  CreateIncidentFromAlertUseCase,
  GetIncidentDetailUseCase,
  IncidentNotFoundError,
  UnexpectedInitialStateError,
} from '../src/index.js';

const incident: IncidentDto = {
  id: '11111111-1111-4111-8111-111111111111',
  status: 'OPEN',
  createdAt: '2026-08-12T09:00:00.000Z',
};
const run: AnalysisRunDto = {
  id: '22222222-2222-4222-8222-222222222222',
  incidentId: incident.id,
  status: 'QUEUED',
  createdAt: '2026-08-12T09:00:00.000Z',
};

function incidents(overrides: Partial<IncidentRepository> = {}): IncidentRepository {
  return {
    create: async () => incident,
    createWithInitialRun: async () => ({ incident, run }),
    findById: async () => incident,
    listRuns: async () => [run],
    ...overrides,
  };
}

function receipts(overrides: Partial<AlertReceiptRepository> = {}): AlertReceiptRepository {
  return {
    receive: async () => ({ incident, run, replayed: false }),
    ...overrides,
  };
}

const alert = {
  title: 'Connection pool exhausted',
  source: 'prometheus',
  severity: 'critical' as const,
  triggeredAt: '2026-08-12T09:00:00.000Z',
  service: 'billing-api',
  summary: 'Database connections are exhausted.',
};

function runs(events: RunEvent[] = []): AnalysisRunRepository {
  return {
    create: async () => run,
    findById: async () => run,
    listForIncident: async () => [run],
    appendEvent: async () => events[0]!,
    listEvents: async () => events,
    saveCheckpoint: async () => {
      throw new Error('Not used by this test.');
    },
    findLatestCheckpoint: async () => null,
  };
}

function event(id: string, createdAt: string): RunEvent {
  return {
    id,
    incidentId: incident.id,
    runId: run.id,
    parentEventId: null,
    type: 'run.started',
    payload: {},
    schemaVersion: 1,
    createdAt,
  };
}

describe('application use cases', () => {
  it('creates an OPEN incident and QUEUED initial run', async () => {
    const useCase = new CreateIncidentFromAlertUseCase(receipts());

    await expect(
      useCase.execute({
        requestId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'alert-1',
        alert,
        run: { initiatedBy: 'on-call' },
      }),
    ).resolves.toEqual({ incident, run });
  });

  it('rejects an unexpected initial state', async () => {
    const useCase = new CreateIncidentFromAlertUseCase(
      receipts({
        receive: async () => ({
          incident: { ...incident, status: 'CLOSED' },
          run,
          replayed: false,
        }),
      }),
    );

    await expect(
      useCase.execute({
        requestId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: 'alert-1',
        alert,
      }),
    ).rejects.toBeInstanceOf(
      UnexpectedInitialStateError,
    );
  });

  it('returns a stable, sorted incident timeline', async () => {
    const useCase = new GetIncidentDetailUseCase(
      incidents(),
      runs([
        event('33333333-3333-4333-8333-333333333333', '2026-08-12T10:00:00.000Z'),
        event('11111111-3333-4333-8333-333333333333', '2026-08-12T09:00:00.000Z'),
        event('22222222-3333-4333-8333-333333333333', '2026-08-12T10:00:00.000Z'),
      ]),
    );

    const detail = await useCase.execute({
      incidentId: incident.id,
      requestId: '00000000-0000-4000-8000-000000000001',
    });

    expect(detail.events.map((value) => value.id)).toEqual([
      '11111111-3333-4333-8333-333333333333',
      '22222222-3333-4333-8333-333333333333',
      '33333333-3333-4333-8333-333333333333',
    ]);
  });

  it('reports a missing incident', async () => {
    const useCase = new GetIncidentDetailUseCase(incidents({ findById: async () => null }), runs());

    await expect(
      useCase.execute({
        incidentId: incident.id,
        requestId: '00000000-0000-4000-8000-000000000001',
      }),
    ).rejects.toBeInstanceOf(IncidentNotFoundError);
  });
});
