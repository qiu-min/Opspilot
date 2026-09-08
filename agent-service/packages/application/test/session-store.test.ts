import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@opspilot/agent-runtime';
import type { SessionEntry } from '@opspilot/domain';

import {
  appendSessionEntry,
  buildSessionContext,
  createSessionFile,
  FileSystemSessionStore,
  serializeSessionMetadata,
  Session,
  SessionMetadataPersistenceError,
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

function legacySession(
  directory: string,
  sessionId: string,
): {
  session: Session;
  path: string;
} {
  const session = Session.create({
    id: sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  const path = join(directory, `${sessionId}.jsonl`);
  createSessionFile(path, session.getHeader());
  return { session, path };
}

function appendLegacyMessage(
  legacy: { session: Session; path: string },
  text: string,
): SessionEntry {
  const entry = legacy.session.appendMessage(userMessage(text));
  appendSessionEntry(legacy.path, entry);
  return entry;
}

describe('FileSystemSessionStore', () => {
  it('creates the new directory layout and never creates a legacy file', () => {
    const { directory, store } = createStore();
    const session = store.create();
    const sessionId = session.getId();

    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(existsSync(join(directory, sessionId, 'metadata.json'))).toBe(true);
    expect(existsSync(join(directory, sessionId, 'history.jsonl'))).toBe(true);
    expect(existsSync(join(directory, `${sessionId}.jsonl`))).toBe(false);

    const metadata = JSON.parse(
      readFileSync(join(directory, sessionId, 'metadata.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      version: 1,
      id: sessionId,
      title: null,
      createdAt: session.getCreatedAt(),
      updatedAt: session.getUpdatedAt(),
    });
    expect(readFileSync(join(directory, sessionId, 'history.jsonl'), 'utf8')).toContain(
      `"id":"${sessionId}"`,
    );
  });

  it('loads a newly created session and restores metadata, entries, leaf, and branch', () => {
    const { store } = createStore();
    const created = store.create();
    const sessionId = created.getId();
    const entry = created.appendMessage(userMessage('hello'));
    store.appendEntry(sessionId, entry);

    const loaded = store.load(sessionId);

    expect(loaded.getId()).toBe(sessionId);
    expect(loaded.getEntries()).toHaveLength(1);
    expect(loaded.getLeafId()).toBe(entry.id);
    expect(loaded.getBranch().map((item) => item.id)).toEqual([entry.id]);
    expect(buildSessionContext(loaded).messages).toEqual([userMessage('hello')]);
  });

  it('persists renamed metadata without adding history entries', () => {
    const { store } = createStore();
    const created = store.create();
    const sessionId = created.getId();
    const beforeEntries = created.getEntries();
    const beforeLeaf = created.getLeafId();

    created.rename('Sales Analysis');
    store.saveMetadata(sessionId, created.getMetadata());
    const loaded = store.load(sessionId);

    expect(loaded.getTitle()).toBe('Sales Analysis');
    expect(loaded.getEntries()).toEqual(beforeEntries);
    expect(loaded.getLeafId()).toBe(beforeLeaf);
  });

  it('keeps history append-only while advancing metadata.updatedAt', () => {
    const { directory, store } = createStore();
    const created = store.create();
    const sessionId = created.getId();
    const historyPath = join(directory, sessionId, 'history.jsonl');
    const before = readFileSync(historyPath);
    const entry = created.appendMessage(userMessage('append-only'));

    store.appendEntry(sessionId, entry);

    const after = readFileSync(historyPath);
    expect(after.subarray(0, before.length)).toEqual(before);
    expect(after.toString('utf8').split('\n').filter(Boolean)).toHaveLength(2);
    const loaded = store.load(sessionId);
    expect(Date.parse(loaded.getUpdatedAt())).toBeGreaterThanOrEqual(Date.parse(entry.timestamp));
  });

  it('reads legacy JSONL, lazily migrates it, and preserves exact history bytes', () => {
    const { directory, store } = createStore();
    const sessionId = '11111111-1111-4111-8111-111111111111';
    const legacy = legacySession(directory, sessionId);
    appendLegacyMessage(legacy, 'legacy message');
    const legacyBytes = readFileSync(legacy.path);

    const loaded = store.load(sessionId);

    expect(loaded.getId()).toBe(sessionId);
    expect(loaded.getTitle()).toBeNull();
    expect(loaded.getEntries()).toHaveLength(1);
    expect(existsSync(join(directory, sessionId, 'metadata.json'))).toBe(true);
    expect(readFileSync(join(directory, sessionId, 'history.jsonl'))).toEqual(legacyBytes);
    expect(existsSync(legacy.path)).toBe(true);
    const metadata = JSON.parse(
      readFileSync(join(directory, sessionId, 'metadata.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      id: sessionId,
      title: null,
      createdAt: legacy.session.getCreatedAt(),
      updatedAt: legacy.session.getUpdatedAt(),
    });
  });

  it('makes legacy migration idempotent and preserves new metadata', () => {
    const { directory, store } = createStore();
    const sessionId = '22222222-2222-4222-8222-222222222222';
    const legacy = legacySession(directory, sessionId);
    appendLegacyMessage(legacy, 'legacy message');

    const firstLoad = store.load(sessionId);
    firstLoad.rename('Migrated title');
    store.saveMetadata(sessionId, firstLoad.getMetadata());
    const secondLoad = store.load(sessionId);

    expect(secondLoad.getTitle()).toBe('Migrated title');
    expect(readFileSync(join(directory, sessionId, 'history.jsonl'))).toEqual(
      readFileSync(legacy.path),
    );
  });

  it('prefers a complete new layout when legacy and new data coexist', () => {
    const { directory, store } = createStore();
    const sessionId = '33333333-3333-4333-8333-333333333333';
    const legacy = legacySession(directory, sessionId);
    appendLegacyMessage(legacy, 'legacy message');

    const newSession = Session.create({
      id: sessionId,
      timestamp: '2026-02-01T00:00:00.000Z',
    });
    const newEntry = newSession.appendMessage(userMessage('new message'));
    const sessionDirectory = join(directory, sessionId);
    mkdirSync(sessionDirectory);
    writeFileSync(
      join(sessionDirectory, 'metadata.json'),
      serializeSessionMetadata({
        ...newSession.getMetadata(),
        title: 'Authoritative new title',
      }),
    );
    createSessionFile(join(sessionDirectory, 'history.jsonl'), newSession.getHeader());
    appendSessionEntry(join(sessionDirectory, 'history.jsonl'), newEntry);

    const loaded = store.load(sessionId);

    expect(loaded.getTitle()).toBe('Authoritative new title');
    expect(buildSessionContext(loaded).messages).toEqual([userMessage('new message')]);
  });

  it.each([
    ['metadata.json', 'history.jsonl'],
    ['history.jsonl', 'metadata.json'],
  ])('rejects an incomplete new layout and does not fall back to legacy', (present, missing) => {
    const { directory, store } = createStore();
    const sessionId = '44444444-4444-4444-8444-444444444444';
    const legacy = legacySession(directory, sessionId);
    appendLegacyMessage(legacy, 'legacy message');
    const sessionDirectory = join(directory, sessionId);
    mkdirSync(sessionDirectory);
    const session = Session.create({ id: sessionId, timestamp: legacy.session.getCreatedAt() });

    if (present === 'metadata.json') {
      writeFileSync(
        join(sessionDirectory, present),
        serializeSessionMetadata(session.getMetadata()),
      );
    } else {
      createSessionFile(join(sessionDirectory, present), session.getHeader());
    }

    expect(() => store.load(sessionId)).toThrow('incomplete new Session layout');
    expect(existsSync(join(directory, sessionId, missing))).toBe(false);
  });

  it('reconciles stale metadata.updatedAt with a durable history entry and repairs metadata', () => {
    const { directory, store } = createStore();
    const sessionId = '55555555-5555-4555-8555-555555555555';
    const header = {
      type: 'session' as const,
      version: 1,
      id: sessionId,
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const historyEntry: SessionEntry = {
      type: 'message',
      id: 'entry-1',
      parentId: null,
      timestamp: '2026-01-03T00:00:00.000Z',
      message: userMessage('durable'),
    };
    const sessionDirectory = join(directory, sessionId);
    mkdirSync(sessionDirectory);
    writeFileSync(
      join(sessionDirectory, 'metadata.json'),
      serializeSessionMetadata({
        id: sessionId,
        title: null,
        createdAt: header.timestamp,
        updatedAt: '2026-01-02T00:00:00.000Z',
      }),
    );
    createSessionFile(join(sessionDirectory, 'history.jsonl'), header);
    appendSessionEntry(join(sessionDirectory, 'history.jsonl'), historyEntry);

    const loaded = store.load(sessionId);
    const repaired = JSON.parse(
      readFileSync(join(sessionDirectory, 'metadata.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(loaded.getUpdatedAt()).toBe(historyEntry.timestamp);
    expect(repaired.updatedAt).toBe(historyEntry.timestamp);
  });

  it('uses atomic metadata replacement and leaves no temp metadata files', () => {
    const { directory, store } = createStore();
    const session = store.create();
    session.rename('Atomic title');
    store.saveMetadata(session.getId(), session.getMetadata());

    expect(
      readdirSync(join(directory, session.getId())).some((name) => name.includes('.tmp-')),
    ).toBe(false);
    expect(store.load(session.getId()).getTitle()).toBe('Atomic title');
  });

  it.each([
    ['[]', 'must contain a JSON object'],
    ['{"version":2}', 'unsupported version'],
    [
      '{"version":1,"id":"","title":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
      'id must be a non-empty string',
    ],
    [
      '{"version":1,"id":"id","title":"   ","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
      'title must be null or a non-empty string',
    ],
    [
      '{"version":1,"id":"id","title":null,"createdAt":"bad","updatedAt":"2026-01-01T00:00:00.000Z"}',
      'createdAt is invalid',
    ],
    [
      '{"version":1,"id":"id","title":null,"createdAt":"2026-01-02T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}',
      'updatedAt cannot be earlier',
    ],
  ])('rejects invalid metadata records', (content, message) => {
    const { directory, store } = createStore();
    const session = store.create();
    writeFileSync(join(directory, session.getId(), 'metadata.json'), content);

    expect(() => store.load(session.getId())).toThrow(SessionMetadataPersistenceError);
    expect(() => store.load(session.getId())).toThrow(message);
  });

  it.each(['not-a-uuid', '../escape', 'nested/id', String.raw`nested\id`])(
    'rejects invalid sessionId input %s',
    (sessionId) => {
      const { store } = createStore();

      expect(() => store.load(sessionId)).toThrow('Invalid sessionId');
    },
  );

  it('fails when the requested session does not exist', () => {
    const { store } = createStore();

    expect(() => store.load('00000000-0000-4000-8000-000000000000')).toThrow(
      'Session file does not exist',
    );
  });

  it('fails when the stored legacy header id does not match the requested id', () => {
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
