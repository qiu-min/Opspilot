import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';

import { ApiModule } from '../src/index.js';

describe('API module boundary', () => {
  it('initializes without application or persistence bindings', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ApiModule.register({
          providers: [],
          exports: [],
        }),
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  });
});
