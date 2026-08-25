import type { Provider } from '@nestjs/common';
import { ApiModule } from '@opspilot/api';
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
import { createDatabaseRepositoryContainer, type DatabaseRepositoryContainer } from '@opspilot/db';

const DATABASE_LIFECYCLE = Symbol('DATABASE_LIFECYCLE');

export function createApiRuntimeModule(
  repositories: DatabaseRepositoryContainer = createDatabaseRepositoryContainer(),
) {
  const providers: Provider[] = [
    { provide: INCIDENT_REPOSITORY, useValue: repositories.incidents },
    { provide: ANALYSIS_RUN_REPOSITORY, useValue: repositories.analysisRuns },
    { provide: EVIDENCE_REPOSITORY, useValue: repositories.evidence },
    { provide: ACTION_REPOSITORY, useValue: repositories.actions },
    { provide: ALERT_RECEIPT_REPOSITORY, useValue: repositories.alertReceipts },
    {
      provide: CREATE_INCIDENT_FROM_ALERT,
      useFactory: (receipts: DatabaseRepositoryContainer['alertReceipts']) =>
        new CreateIncidentFromAlertUseCase(receipts),
      inject: [ALERT_RECEIPT_REPOSITORY],
    },
    {
      provide: GET_INCIDENT_DETAIL,
      useFactory: (
        incidents: DatabaseRepositoryContainer['incidents'],
        analysisRuns: DatabaseRepositoryContainer['analysisRuns'],
      ) => new GetIncidentDetailUseCase(incidents, analysisRuns),
      inject: [INCIDENT_REPOSITORY, ANALYSIS_RUN_REPOSITORY],
    },
    {
      provide: DATABASE_LIFECYCLE,
      useValue: { onApplicationShutdown: () => repositories.disconnect() },
    },
  ];

  return ApiModule.register({
    providers,
    exports: [
      INCIDENT_REPOSITORY,
      ANALYSIS_RUN_REPOSITORY,
      EVIDENCE_REPOSITORY,
      ACTION_REPOSITORY,
      ALERT_RECEIPT_REPOSITORY,
      CREATE_INCIDENT_FROM_ALERT,
      GET_INCIDENT_DETAIL,
      DATABASE_LIFECYCLE,
    ],
  });
}
