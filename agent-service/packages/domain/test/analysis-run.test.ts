import { describe, expect, it } from 'vitest';

import {
  analysisRunStatusSchema,
  canTransitionAnalysisRun,
  transitionAnalysisRun,
} from '../src/index.js';

describe('AnalysisRun 状态机', () => {
  it('允许 QUEUED → RUNNING', () => {
    expect(transitionAnalysisRun('QUEUED', 'RUNNING')).toBe('RUNNING');
    expect(canTransitionAnalysisRun('QUEUED', 'RUNNING')).toBe(true);
  });

  it('拒绝 COMPLETED 后继续转换', () => {
    expect(canTransitionAnalysisRun('COMPLETED', 'RUNNING')).toBe(false);
    expect(() => transitionAnalysisRun('COMPLETED', 'RUNNING')).toThrow(
      'AnalysisRun cannot transition from COMPLETED to RUNNING.',
    );
  });

  it('校验 AnalysisRun 状态输入', () => {
    expect(analysisRunStatusSchema.parse('WAITING_APPROVAL')).toBe('WAITING_APPROVAL');
    expect(analysisRunStatusSchema.safeParse('UNKNOWN').success).toBe(false);
  });
});
