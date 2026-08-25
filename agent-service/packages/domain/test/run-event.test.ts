import { describe, expect, it } from 'vitest';

import { runEventSchema } from '../src/index.js';

describe('RunEvent schema', () => {
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  it('接受完整且有效的事件', () => {
    const result = runEventSchema.parse({
      id,
      incidentId: id,
      runId: id,
      parentEventId: null,
      type: 'run.started',
      payload: { source: 'alert' },
      schemaVersion: 1,
      createdAt: '2026-08-11T12:00:00.000Z',
    });

    expect(result.type).toBe('run.started');
    expect(result.schemaVersion).toBe(1);
  });

  it('拒绝无效事件', () => {
    const result = runEventSchema.safeParse({
      id: 'not-a-uuid',
      incidentId: id,
      runId: id,
      parentEventId: null,
      type: 'not-a-real-event',
      payload: {},
      schemaVersion: 0,
      createdAt: 'not-a-date',
    });

    expect(result.success).toBe(false);
  });
});
