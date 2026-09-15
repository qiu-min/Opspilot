import { describe, expect, it } from 'vitest';

import { createToolMutationId } from '../src/index.js';

describe('createToolMutationId', () => {
  it('is deterministic for the same Turn and ToolCall', () => {
    expect(createToolMutationId('turn-A', 'call-1')).toBe('turn:6:turn-A:call:6:call-1');
    expect(createToolMutationId('turn-A', 'call-1')).toBe(
      createToolMutationId('turn-A', 'call-1'),
    );
  });

  it('scopes a repeated Provider callId to a different Turn', () => {
    expect(createToolMutationId('turn-A', 'call-1')).not.toBe(
      createToolMutationId('turn-B', 'call-1'),
    );
  });

  it('encodes delimiter-containing ids without tuple collisions', () => {
    expect(createToolMutationId('turn:a', 'call:b')).not.toBe(
      createToolMutationId('turn', 'a:call:b'),
    );
  });
});
