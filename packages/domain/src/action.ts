import { z } from 'zod';

import { DomainError, DomainErrorCode } from './errors.js';

export const actionStatusSchema = z.enum([
  'PROPOSED',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
]);

export type ActionStatus = z.infer<typeof actionStatusSchema>;

export const actionTransitions: Record<ActionStatus, ActionStatus[]> = {
  PROPOSED: ['PENDING_APPROVAL'],
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['EXECUTING'],
  REJECTED: [],
  EXECUTING: ['SUCCEEDED', 'FAILED'],
  SUCCEEDED: [],
  FAILED: [],
};

export function canTransitionAction(from: ActionStatus, to: ActionStatus): boolean {
  return actionTransitions[from].includes(to);
}

export function transitionAction(from: ActionStatus, to: ActionStatus): ActionStatus {
  if (!canTransitionAction(from, to)) {
    throw new DomainError(
      DomainErrorCode.INVALID_STATE_TRANSITION,
      `Action cannot transition from ${from} to ${to}.`,
    );
  }

  return to;
}
