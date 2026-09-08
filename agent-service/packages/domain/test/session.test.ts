import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@opspilot/agent-runtime';

import {
  Session,
  SessionEntryNotFoundError,
  SessionMetadataError,
  type SessionEntry,
} from '../src/index.js';

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function entry(id: string, parentId: string | null, type: 'message' = 'message'): SessionEntry {
  return {
    type,
    id,
    parentId,
    timestamp: '2026-01-01T00:00:00.000Z',
    message: userMessage(id),
  } as SessionEntry;
}

describe('Session domain', () => {
  it('creates and appends all supported domain entry types', () => {
    const session = Session.create({ id: 'session-1', timestamp: '2026-01-01T00:00:00.000Z' });
    const message = session.appendMessage(userMessage('hello'));
    const model = session.appendModelChange('provider', 'model');
    const thinking = session.appendThinkingLevelChange('high');
    const compaction = session.appendCompaction('summary', message.id, 12);

    expect(message.parentId).toBeNull();
    expect(model.parentId).toBe(message.id);
    expect(thinking.parentId).toBe(model.id);
    expect(compaction.parentId).toBe(thinking.id);
    expect(session.getLeafId()).toBe(compaction.id);
    expect(session.getEntry(model.id)).toEqual(model);
    expect(session.getEntries()).toHaveLength(4);
  });

  it('restores the active leaf and branch from durable entries', () => {
    const session = Session.restore(
      { type: 'session', version: 1, id: 'session-1', timestamp: '2026-01-01T00:00:00.000Z' },
      [entry('a', null), entry('b', 'a'), entry('c', 'b'), entry('d', 'b')],
    );

    expect(session.getLeafId()).toBe('d');
    expect(session.getBranch().map((item) => item.id)).toEqual(['a', 'b', 'd']);
    session.branch('c');
    expect(session.getBranch().map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('rejects duplicate ids, missing parents, and parent cycles during restore', () => {
    const header = {
      type: 'session' as const,
      version: 1,
      id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    expect(() => Session.restore(header, [entry('a', null), entry('a', 'a')])).toThrow(
      'Duplicate session entry id: a',
    );
    expect(() => Session.restore(header, [entry('a', null), entry('b', 'missing')])).toThrow(
      'references missing parent: missing',
    );
    expect(() =>
      Session.restore(header, [entry('root', null), entry('a', 'b'), entry('b', 'a')]),
    ).toThrow('parentId cycle detected');
  });

  it('rejects invalid branches and compaction boundaries', () => {
    const session = Session.create();
    const first = session.appendMessage(userMessage('first'));
    const second = session.appendMessage(userMessage('second'));
    const third = session.appendMessage(userMessage('third'));

    expect(() => session.branch('missing')).toThrow(SessionEntryNotFoundError);
    expect(() => session.appendCompaction('', first.id, 0)).toThrow(
      'Compaction summary must be non-empty',
    );
    expect(() => session.appendCompaction('summary', 'missing', 0)).toThrow(
      'Session entry not found: missing',
    );
    expect(() => session.appendCompaction('summary', first.id, -1)).toThrow(
      'tokensBefore must be a non-negative integer',
    );

    const compaction = session.appendCompaction('summary', second.id, 10);
    expect(() => session.appendCompaction('second', compaction.id, 10)).toThrow(
      'cannot point to a compaction entry',
    );
    session.branch(second.id);
    expect(() => session.appendCompaction('outside branch', third.id, 10)).toThrow(
      'must belong to the active branch',
    );
  });

  it('does not expose mutable internal entry state', () => {
    const session = Session.create();
    const message = session.appendMessage(userMessage('original'));
    const entries = session.getEntries();

    entries.pop();

    expect(session.getEntries()).toHaveLength(1);
    expect(session.getEntry(message.id)).toEqual(message);
  });

  it('creates product metadata with a null title and matching timestamps', () => {
    const session = Session.create({
      id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(session.getMetadata()).toEqual({
      id: 'session-1',
      title: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(session.getHeader().timestamp).toBe(session.getCreatedAt());
  });

  it('renames without changing history, leaf, or branch', () => {
    const session = Session.create({ timestamp: '2026-01-01T00:00:00.000Z' });
    const first = session.appendMessage(userMessage('first'));
    const beforeBranch = session.getBranch();
    const beforeUpdatedAt = session.getUpdatedAt();

    session.rename('  Sales Analysis  ');

    expect(session.getTitle()).toBe('Sales Analysis');
    expect(session.getUpdatedAt()).not.toBe(beforeUpdatedAt);
    expect(session.getEntries()).toEqual([first]);
    expect(session.getLeafId()).toBe(first.id);
    expect(session.getBranch()).toEqual(beforeBranch);
  });

  it.each(['', '   '])('rejects an empty title: %j', (title) => {
    const session = Session.create();
    expect(() => session.rename(title)).toThrow(SessionMetadataError);
  });

  it('advances updatedAt for every durable history mutation', () => {
    const session = Session.create({ timestamp: '2020-01-01T00:00:00.000Z' });
    const initial = session.getUpdatedAt();
    const message = session.appendMessage(userMessage('message'));
    const afterMessage = session.getUpdatedAt();
    const model = session.appendModelChange('provider', 'model');
    const afterModel = session.getUpdatedAt();
    const thinking = session.appendThinkingLevelChange('high');
    const afterThinking = session.getUpdatedAt();
    session.appendCompaction('summary', message.id, 12);

    expect(message.timestamp).toBe(afterMessage);
    expect(model.timestamp).toBe(afterModel);
    expect(thinking.timestamp).toBe(afterThinking);
    expect(afterMessage > initial).toBe(true);
    expect(afterModel > afterMessage).toBe(true);
    expect(afterThinking > afterModel).toBe(true);
    expect(session.getUpdatedAt() > afterThinking).toBe(true);
  });

  it('restores and validates metadata against the history header', () => {
    const header = {
      type: 'session' as const,
      version: 1,
      id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const metadata = {
      id: 'session-1',
      title: null,
      createdAt: header.timestamp,
      updatedAt: header.timestamp,
    };

    expect(Session.restore({ metadata, header, entries: [] }).getTitle()).toBeNull();
    expect(() => Session.restore({ ...metadata, id: 'other' }, header, [])).toThrow(
      'does not match history header id',
    );
    expect(() =>
      Session.restore(
        {
          ...metadata,
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        header,
        [],
      ),
    ).toThrow('does not match history header timestamp');
    expect(() =>
      Session.restore(
        { ...metadata, createdAt: 'not-a-timestamp' },
        { ...header, timestamp: 'not-a-timestamp' },
        [],
      ),
    ).toThrow('createdAt is invalid');
    expect(() =>
      Session.restore({ ...metadata, updatedAt: '2025-12-31T23:59:59.000Z' }, header, []),
    ).toThrow('updatedAt cannot be earlier than createdAt');
  });

  it('reconciles updatedAt with the latest durable entry on restore', () => {
    const header = {
      type: 'session' as const,
      version: 1,
      id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    };
    const restored = Session.restore({
      metadata: {
        id: header.id,
        title: null,
        createdAt: header.timestamp,
        updatedAt: header.timestamp,
      },
      header,
      entries: [
        {
          ...entry('first', null),
          timestamp: '2026-01-03T00:00:00.000Z',
        },
      ],
    });

    expect(restored.getUpdatedAt()).toBe('2026-01-03T00:00:00.000Z');
  });
});
