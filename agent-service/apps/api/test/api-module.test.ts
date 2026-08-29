import { describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';

import { ApiModule } from '../src/index.js';

describe('API module boundary', () => {
  it('requires the RunConversationTurn application binding at compile time', async () => {
    await expect(
      Test.createTestingModule({
        imports: [ApiModule.register({ providers: [], exports: [] })],
      }).compile(),
    ).rejects.toThrow(/RunConversationTurn|ConversationsController/);
  });
});
