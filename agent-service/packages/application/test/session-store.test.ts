import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@opspilot/agent-runtime';

import {
  buildSessionContext,
  createSessionFile,
  FileSystemSessionStore,
  Session,
} from '../src/index.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createStore(): { directory: string; store: FileSystemSessionStore } {
  const directory = mkdtempSync(join(tmpdir(), 'opspilot-session-store-'));
  directories.push(directory);
  return { directory, store: new FileSystemSessionStore(directory) };
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

describe('FileSystemSessionStore', () => {
  it('creates a persisted session with a matching filename and header id', () => {
    const { directory, store } = createStore();
    const session = store.create();
    const sessionId = session.getHeader().id;

    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(readFileSync(join(directory, `${sessionId}.jsonl`), 'utf8')).toContain(
      `"id":"${sessionId}"`,
    );
  });

  it('loads a newly created session and restores entries and messages', () => {
    const { store } = createStore();
    const created = store.create();
    const sessionId = created.getHeader().id;
    const entry = created.appendMessage(userMessage('hello'));
    store.appendEntry(sessionId, entry);

    const loaded = store.load(sessionId);

    expect(loaded.getHeader().id).toBe(sessionId);
    expect(loaded.getEntries()).toHaveLength(1);
    expect(buildSessionContext(loaded).messages).toEqual([userMessage('hello')]);
  });

  it.each(['not-a-uuid', '../escape', 'nested/id', String.raw`nested\id`])(
    'rejects invalid sessionId input %s',
    (sessionId) => {
      const { store } = createStore();

      expect(() => store.load(sessionId)).toThrow('Invalid sessionId');
    },
  );

  it('fails when the requested session file does not exist', () => {
    const { store } = createStore();

    expect(() => store.load('00000000-0000-4000-8000-000000000000')).toThrow(
      'Session file does not exist',
    );
  });

  it('fails when the stored header id does not match the requested id', () => {
    const { directory, store } = createStore();
    const requestedId = '00000000-0000-4000-8000-000000000001';
    const storedId = '00000000-0000-4000-8000-000000000002';
    const filePath = join(directory, `${requestedId}.jsonl`);

    createSessionFile(filePath, Session.create({ id: storedId }).getHeader());

    expect(() => store.load(requestedId)).toThrow(
      `Session header id does not match requested sessionId: ${storedId} !== ${requestedId}.`,
    );
  });
});
