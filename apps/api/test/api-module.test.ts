import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { CREATE_INCIDENT_FROM_ALERT, GET_INCIDENT_DETAIL } from '@opspilot/application';

import { ApiModule } from '../src/index.js';

describe('API module boundary', () => {
  it('initializes without a database implementation', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ApiModule.register({
          providers: [
            { provide: CREATE_INCIDENT_FROM_ALERT, useValue: { execute: async () => null } },
            { provide: GET_INCIDENT_DETAIL, useValue: { execute: async () => null } },
          ],
          exports: [CREATE_INCIDENT_FROM_ALERT, GET_INCIDENT_DETAIL],
        }),
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  });
});
