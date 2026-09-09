import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import {
  FileSystemTurnExecutionContextStore,
  TurnExecutionContextStoreError,
} from '../src/index.js';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('FileSystemTurnExecutionContextStore', () => {
  it('writes and restores only the durable Excel recovery input', () => {
    const root = mkdtempSync(join(tmpdir(), 'opspilot-turn-context-'));
    roots.push(root);
    const store = new FileSystemTurnExecutionContextStore(root);
    store.save('turn-1', {
      version: 1,
      excelResource: { id: 'resource-1', filePath: 'uploads/book.xlsx' },
    });

    expect(store.load('turn-1')).toEqual({
      version: 1,
      excelResource: { id: 'resource-1', filePath: 'uploads/book.xlsx' },
    });
    const content = readFileSync(join(root, 'turns', 'turn-1', 'execution.json'), 'utf8');
    expect(content).not.toContain('message');
    expect(content).not.toContain('accessToken');
    expect(content).not.toContain('reasoning');
  });

  it('returns null for a legacy Turn without execution.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'opspilot-turn-context-'));
    roots.push(root);
    expect(new FileSystemTurnExecutionContextStore(root).load('turn-1')).toBeNull();
  });

  it('rejects unsupported fields and unsafe ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'opspilot-turn-context-'));
    roots.push(root);
    const store = new FileSystemTurnExecutionContextStore(root);
    expect(() => store.save('../turn', { version: 1 })).toThrow(TurnExecutionContextStoreError);
    expect(() =>
      store.save('turn-1', {
        version: 1,
        excelResource: { id: 'resource-1', filePath: 'book.xlsx', secret: 'nope' },
      } as never),
    ).toThrow(TurnExecutionContextStoreError);
  });
});
