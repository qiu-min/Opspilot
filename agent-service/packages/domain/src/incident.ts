import { z } from 'zod';
import { DomainError, DomainErrorCode } from './errors.js';

export const incidentStatusSchema = z.enum([
  'OPEN',
  'INVESTIGATING',
  'MITIGATING',
  'RESOLVED',
  'CLOSED',
]);

export type IncidentStatus = z.infer<typeof incidentStatusSchema>;

export const incidentTransitions: Record<IncidentStatus, IncidentStatus[]> = {
  OPEN: ['INVESTIGATING', 'CLOSED'],
  INVESTIGATING: ['MITIGATING', 'RESOLVED', 'CLOSED'],
  MITIGATING: ['RESOLVED', 'CLOSED'],
  RESOLVED: ['CLOSED'],
  CLOSED: [],
};

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
  return incidentTransitions[from].includes(to);
}

export function transitionIncident(from: IncidentStatus, to: IncidentStatus): IncidentStatus {
  if (!canTransitionIncident(from, to)) {
    throw new DomainError(
      DomainErrorCode.INVALID_STATE_TRANSITION,
      `Incident cannot transition from ${from} to ${to}.`,
    );
  }

  return to;
}
