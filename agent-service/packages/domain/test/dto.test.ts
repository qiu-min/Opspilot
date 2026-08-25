import { describe, expect, it } from 'vitest';

import { actionDtoSchema, analysisRunDtoSchema, incidentDtoSchema } from '../src/index.js';

describe('domain DTO schemas', () => {
  const id = '3fa85f64-5717-4562-b3fc-2c963f66afa6';
  const createdAt = '2026-08-12T12:00:00.000Z';

  it('parses status projections for all domain entities', () => {
    expect(incidentDtoSchema.parse({ id, status: 'OPEN', createdAt })).toEqual({
      id,
      status: 'OPEN',
      createdAt,
    });
    expect(
      analysisRunDtoSchema.parse({ id, incidentId: id, status: 'RUNNING', createdAt }),
    ).toEqual({
      id,
      incidentId: id,
      status: 'RUNNING',
      createdAt,
    });
    expect(actionDtoSchema.parse({ id, incidentId: id, runId: id, status: 'APPROVED' })).toEqual({
      id,
      incidentId: id,
      runId: id,
      status: 'APPROVED',
    });
  });

  it('rejects an invalid status in a DTO', () => {
    expect(incidentDtoSchema.safeParse({ id, status: 'UNKNOWN', createdAt }).success).toBe(false);
    expect(incidentDtoSchema.safeParse({ id, status: 'OPEN' }).success).toBe(false);
  });
});
