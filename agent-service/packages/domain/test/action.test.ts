import { describe, expect, it } from 'vitest';

import { actionStatusSchema, canTransitionAction, transitionAction } from '../src/index.js';

describe('Action 状态机', () => {
  it('要求审批后才能执行', () => {
    expect(canTransitionAction('PENDING_APPROVAL', 'APPROVED')).toBe(true);
    expect(canTransitionAction('PENDING_APPROVAL', 'EXECUTING')).toBe(false);

    expect(transitionAction('APPROVED', 'EXECUTING')).toBe('EXECUTING');
  });

  it('允许执行成功或失败', () => {
    expect(transitionAction('EXECUTING', 'SUCCEEDED')).toBe('SUCCEEDED');
    expect(transitionAction('EXECUTING', 'FAILED')).toBe('FAILED');
  });

  it('校验 Action 状态输入', () => {
    expect(actionStatusSchema.parse('PENDING_APPROVAL')).toBe('PENDING_APPROVAL');
    expect(actionStatusSchema.safeParse('UNKNOWN').success).toBe(false);
  });
});
