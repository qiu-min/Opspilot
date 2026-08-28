import { describe, expect, it } from 'vitest';

import { Test, type TestingModule } from '@nestjs/testing';

import { createApiRuntimeModule } from '../src/runtime-module.js';

describe('API runtime composition root', () => {
  it('creates the API composition root without persistence bindings', async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [createApiRuntimeModule()],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  });
});
