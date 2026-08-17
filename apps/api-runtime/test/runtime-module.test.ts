import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgresql://opspilot:opspilot@localhost:5432/opspilot';
});

import { Test, type TestingModule } from '@nestjs/testing';
import {
  ACTION_REPOSITORY,
  ALERT_RECEIPT_REPOSITORY,
  ANALYSIS_RUN_REPOSITORY,
  CREATE_INCIDENT_FROM_ALERT,
  CreateIncidentFromAlertUseCase,
  EVIDENCE_REPOSITORY,
  GET_INCIDENT_DETAIL,
  GetIncidentDetailUseCase,
  INCIDENT_REPOSITORY,
} from '@opspilot/application';
import {
  PrismaActionRepository,
  PrismaAlertReceiptRepository,
  PrismaAnalysisRunRepository,
  PrismaEvidenceRepository,
  PrismaIncidentRepository,
} from '@opspilot/db';

import { createApiRuntimeModule } from '../src/runtime-module.js';

describe('API runtime composition root', () => {
  let module: TestingModule;

  beforeAll(async () => {
    module = await Test.createTestingModule({ imports: [createApiRuntimeModule()] }).compile();
  });

  afterAll(async () => {
    await module.close();
  });

  it('binds application ports to Prisma implementations and exposes use cases', () => {
    expect(module.get(INCIDENT_REPOSITORY)).toBeInstanceOf(PrismaIncidentRepository);
    expect(module.get(ANALYSIS_RUN_REPOSITORY)).toBeInstanceOf(PrismaAnalysisRunRepository);
    expect(module.get(EVIDENCE_REPOSITORY)).toBeInstanceOf(PrismaEvidenceRepository);
    expect(module.get(ACTION_REPOSITORY)).toBeInstanceOf(PrismaActionRepository);
    expect(module.get(ALERT_RECEIPT_REPOSITORY)).toBeInstanceOf(PrismaAlertReceiptRepository);
    expect(module.get(CREATE_INCIDENT_FROM_ALERT)).toBeInstanceOf(CreateIncidentFromAlertUseCase);
    expect(module.get(GET_INCIDENT_DETAIL)).toBeInstanceOf(GetIncidentDetailUseCase);
  });
});
