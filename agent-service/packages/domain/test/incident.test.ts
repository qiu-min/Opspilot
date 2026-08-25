import { describe, expect, it } from 'vitest';

import {
  DomainError,
  DomainErrorCode,
  canTransitionIncident,
  transitionIncident,
  incidentStatusSchema,
} from '../src/index.js';

describe('Incident 状态机', () => {
  it('允许 OPEN → INVESTIGATING', () => {
    expect(transitionIncident('OPEN', 'INVESTIGATING')).toBe('INVESTIGATING');
    expect(canTransitionIncident('OPEN', 'INVESTIGATING')).toBe(true);
  });

  it('拒绝 OPEN → RESOLVED', () => {
    expect(canTransitionIncident('OPEN', 'RESOLVED')).toBe(false);

    expect(() => transitionIncident('OPEN', 'RESOLVED')).toThrow(DomainError);

    expect(() => transitionIncident('OPEN', 'RESOLVED')).toThrow(
      expect.objectContaining({
        code: DomainErrorCode.INVALID_STATE_TRANSITION,
      }),
    );
  });

  it('校验 Incident 状态输入', () => {
    expect(incidentStatusSchema.parse('OPEN')).toBe('OPEN');
    expect(incidentStatusSchema.safeParse('UNKNOWN').success).toBe(false);
  });
});
