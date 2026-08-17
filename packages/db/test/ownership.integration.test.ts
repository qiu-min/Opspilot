import { afterAll, describe, expect, it } from 'vitest';

import {
  PrismaActionRepository,
  PrismaAnalysisRunRepository,
  PrismaEvidenceRepository,
  PrismaIncidentRepository,
} from '../src/index.js';
import { prisma } from '../src/testing.js';

const rollback = new Error('rollback test transaction');

afterAll(async () => {
  await prisma.$disconnect();
});

async function inRollbackTransaction(
  run: Parameters<typeof prisma.$transaction>[0],
): Promise<void> {
  await expect(
    prisma.$transaction(async (transaction) => {
      await run(transaction);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

describe('database repositories', () => {
  it('creates an incident with its initial run atomically and exposes its run overview', async () => {
    await inRollbackTransaction(async (transaction) => {
      const incidents = new PrismaIncidentRepository(transaction as typeof prisma);
      const created = await incidents.createWithInitialRun({
        run: { initiatedBy: 'integration-test', modelName: 'test-model' },
      });

      expect(created.run.incidentId).toBe(created.incident.id);
      expect(created.incident.createdAt).toMatch(/Z$/);
      expect(created.run.createdAt).toMatch(/Z$/);
      expect(await incidents.findById(created.incident.id)).toEqual(created.incident);
      expect(await incidents.listRuns(created.incident.id)).toEqual([created.run]);
    });
  });

  it('appends and replays events while enforcing incident ownership and immutability', async () => {
    await inRollbackTransaction(async (transaction) => {
      const incidents = new PrismaIncidentRepository(transaction as typeof prisma);
      const runs = new PrismaAnalysisRunRepository(transaction);
      const incident = await incidents.create();
      const firstRun = await runs.create({ incidentId: incident.id });
      const secondRun = await runs.create({ incidentId: incident.id });
      const started = await runs.appendEvent({
        incidentId: incident.id,
        runId: firstRun.id,
        type: 'run.started',
        payload: { source: 'test' },
      });
      const branched = await runs.appendEvent({
        incidentId: incident.id,
        runId: secondRun.id,
        parentEventId: started.id,
        type: 'run.completed',
        payload: { result: 'branched' },
        schemaVersion: 2,
      });
      const otherIncident = await incidents.create();
      const otherRun = await runs.create({ incidentId: otherIncident.id });

      expect(branched.parentEventId).toBe(started.id);
      expect(await runs.listEvents(incident.id)).toHaveLength(2);
      expect(await runs.listEvents(incident.id, secondRun.id)).toEqual([branched]);
      await expect(
        runs.appendEvent({
          incidentId: otherIncident.id,
          runId: otherRun.id,
          parentEventId: started.id,
          type: 'run.failed',
          payload: {},
        }),
      ).rejects.toThrow('Parent event does not belong to the incident.');
      await transaction.$executeRawUnsafe('SAVEPOINT run_event_update');
      await expect(
        transaction.$executeRawUnsafe(
          `UPDATE "run_events" SET "schemaVersion" = 99 WHERE "id" = '${started.id}'`,
        ),
      ).rejects.toThrow('run_events are immutable');
      await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT run_event_update');
      await expect(
        transaction.$executeRawUnsafe(`DELETE FROM "run_events" WHERE "id" = '${started.id}'`),
      ).rejects.toThrow('run_events are immutable');
    });
  });

  it('persists evidence, checkpoints, and action details within their owning incident', async () => {
    await inRollbackTransaction(async (transaction) => {
      const incidents = new PrismaIncidentRepository(transaction as typeof prisma);
      const runs = new PrismaAnalysisRunRepository(transaction);
      const evidence = new PrismaEvidenceRepository(transaction);
      const actions = new PrismaActionRepository(transaction);
      const incident = await incidents.create();
      const sourceRun = await runs.create({ incidentId: incident.id });
      const followUpRun = await runs.create({ incidentId: incident.id });
      const savedEvidence = await evidence.create({
        incidentId: incident.id,
        sourceRunId: sourceRun.id,
        kind: 'METRICS',
        summary: 'pool exhausted',
        content: { utilization: 100 },
        contentHash: 'sha256:test',
      });
      const checkpoint = await runs.saveCheckpoint({
        runId: followUpRun.id,
        summary: 'reuse evidence',
        confirmedFacts: ['pool exhausted'],
        hypotheses: ['connection pool'],
        evidenceIds: [savedEvidence.id],
        openQuestions: [],
        actionStates: [],
      });
      const action = await actions.create({
        incidentId: incident.id,
        runId: followUpRun.id,
        actionType: 'scaleDeployment',
        riskLevel: 'high',
        parameters: { replicas: 3 },
        idempotencyKey: 'action-test',
      });
      await transaction.approval.create({
        data: { actionId: action.id, decision: 'APPROVED', decidedBy: 'on-call' },
      });
      await transaction.execution.create({
        data: { actionId: action.id, executor: 'worker', idempotencyKey: 'execution-test' },
      });
      const otherIncident = await incidents.create();

      expect(await evidence.listForIncident(incident.id)).toEqual([savedEvidence]);
      expect(await runs.findLatestCheckpoint(followUpRun.id)).toEqual(checkpoint);
      expect((await actions.findById(action.id))?.approval?.decidedBy).toBe('on-call');
      expect((await actions.findById(action.id))?.execution?.executor).toBe('worker');
      await expect(
        evidence.create({
          incidentId: otherIncident.id,
          sourceRunId: sourceRun.id,
          kind: 'LOGS',
          summary: 'invalid source',
          content: {},
          contentHash: 'sha256:invalid',
        }),
      ).rejects.toThrow('Analysis run does not belong to the incident.');
      await expect(
        actions.create({
          incidentId: otherIncident.id,
          runId: followUpRun.id,
          actionType: 'restartService',
          riskLevel: 'high',
          parameters: {},
        }),
      ).rejects.toThrow('Analysis run does not belong to the incident.');
    });
  });
});
