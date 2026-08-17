import type { AnalysisRunDto, IncidentDto, RunEvent } from '@opspilot/domain';

import type { AnalysisRunRepository, IncidentRepository } from '../ports/repositories.js';
import { IncidentNotFoundError } from './errors.js';

export interface IncidentDetail {
  readonly incident: IncidentDto;
  readonly runs: readonly AnalysisRunDto[];
  readonly events: readonly RunEvent[];
}

export interface GetIncidentDetailInput {
  /** Cross-layer correlation metadata; it is intentionally not persisted. */
  readonly requestId: string;
  readonly incidentId: string;
}

export interface GetIncidentDetail {
  execute(input: GetIncidentDetailInput): Promise<IncidentDetail>;
}

export class GetIncidentDetailUseCase implements GetIncidentDetail {
  constructor(
    private readonly incidents: IncidentRepository,
    private readonly analysisRuns: AnalysisRunRepository,
  ) {}

  async execute({ incidentId }: GetIncidentDetailInput): Promise<IncidentDetail> {
    const incident = await this.incidents.findById(incidentId);
    if (!incident) throw new IncidentNotFoundError(incidentId);

    const [runs, events] = await Promise.all([
      this.incidents.listRuns(incidentId),
      this.analysisRuns.listEvents(incidentId),
    ]);

    return {
      incident,
      runs,
      events: [...events].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      ),
    };
  }
}
