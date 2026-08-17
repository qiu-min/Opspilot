import type {
  ActionRepository,
  AlertReceiptRepository,
  AnalysisRunRepository,
  EvidenceRepository,
  IncidentRepository,
} from '@opspilot/application';

import { prisma } from './client.js';
import { createRepositories } from './repositories.js';

export interface DatabaseRepositoryContainer {
  readonly incidents: IncidentRepository;
  readonly alertReceipts: AlertReceiptRepository;
  readonly analysisRuns: AnalysisRunRepository;
  readonly evidence: EvidenceRepository;
  readonly actions: ActionRepository;
  disconnect(): Promise<void>;
}

/**
 * Adapts the package-owned Prisma singleton to application repository ports
 * without exposing the ORM client to consuming applications.
 */
export function createDatabaseRepositoryContainer(): DatabaseRepositoryContainer {
  const repositories = createRepositories(prisma);

  return {
    ...repositories,
    disconnect: () => prisma.$disconnect(),
  };
}
