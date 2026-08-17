import type { AnalysisRunDto, IncidentDto } from '@opspilot/domain';

import type { AlertPayload, AlertReceiptRepository, CreateIncidentWithRunInput } from '../ports/repositories.js';
import { UnexpectedInitialStateError } from './errors.js';

export interface CreateIncidentFromAlertInput {
  /** Cross-layer correlation metadata; it is intentionally not persisted. */
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly alert: AlertPayload;
  readonly run?: CreateIncidentWithRunInput['run'];
}

export interface CreateIncidentFromAlertResult {
  readonly incident: IncidentDto;
  readonly run: AnalysisRunDto;
}

export interface CreateIncidentFromAlert {
  execute(input?: CreateIncidentFromAlertInput): Promise<CreateIncidentFromAlertResult>;
}

export class CreateIncidentFromAlertUseCase implements CreateIncidentFromAlert {
  constructor(private readonly receipts: AlertReceiptRepository) {}

  async execute(input: CreateIncidentFromAlertInput): Promise<CreateIncidentFromAlertResult> {
    const result = await this.receipts.receive({
      idempotencyKey: input.idempotencyKey,
      alert: input.alert,
      run: input.run ?? {},
    });

    if (result.incident.status !== 'OPEN') {
      throw new UnexpectedInitialStateError('Incident', result.incident.status, 'OPEN');
    }
    if (result.run.status !== 'QUEUED') {
      throw new UnexpectedInitialStateError('AnalysisRun', result.run.status, 'QUEUED');
    }

    return { incident: result.incident, run: result.run };
  }
}
