import { z } from 'zod';

import { DomainError, DomainErrorCode } from './errors.js';

export const analysisRunStatusSchema = z.enum([
  'QUEUED',
  'RUNNING',
  'WAITING_APPROVAL',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

export type AnalysisRunStatus = z.infer<typeof analysisRunStatusSchema>;

export const analysisRunTransitions: Record<AnalysisRunStatus, AnalysisRunStatus[]> = {
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'],
  WAITING_APPROVAL: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionAnalysisRun(from: AnalysisRunStatus, to: AnalysisRunStatus): boolean {
  return analysisRunTransitions[from].includes(to);
}

export function transitionAnalysisRun(
  from: AnalysisRunStatus,
  to: AnalysisRunStatus,
): AnalysisRunStatus {
  if (!canTransitionAnalysisRun(from, to)) {
    throw new DomainError(
      DomainErrorCode.INVALID_STATE_TRANSITION,
      `AnalysisRun cannot transition from ${from} to ${to}.`,
    );
  }

  return to;
}
