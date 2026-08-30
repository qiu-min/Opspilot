import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '@opspilot/agent-runtime';
import { createCompactionSummaryMessage, SessionManager } from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'opspilot-session-'));
  temporaryDirectories.push(directory);
  return directory;
}

function userMessage(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: 'assistant',
    api: 'test',
    provider: 'test-provider',
    model: 'test-model',
    content: [{ type: 'text', text }],
    finishReason: 'stop',
  };
}

describe('SessionManager append and tree behavior', () => {
  it('appends entries to the current leaf and protects the entry list', () => {
    const session = SessionManager.inMemory({
      id: 'session-1',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(session.getLeafId()).toBeNull();
    const user = session.appendMessage(userMessage('hello'));
    const assistant = session.appendMessage(assistantMessage('hi'));
    const model = session.appendModelChange('openai', 'gpt-test');
    const thinking = session.appendThinkingLevelChange('high');

    expect(user.parentId).toBeNull();
    expect(assistant.parentId).toBe(user.id);
    expect(model.parentId).toBe(assistant.id);
    expect(thinking.parentId).toBe(model.id);
    expect(session.getLeafId()).toBe(thinking.id);

    const entries = session.getEntries();
    entries.pop();
    expect(session.getEntries()).toHaveLength(4);
    expect(session.getEntry(user.id)?.id).toBe(user.id);
  });

  it('branches without changing old entries and appends from the new leaf', () => {
    const session = SessionManager.inMemory();
    const a = session.appendMessage(userMessage('a'));
    const b = session.appendMessage(assistantMessage('b'));
    const c = session.appendMessage(userMessage('c'));

    session.branch(b.id);
    const d = session.appendMessage(userMessage('d'));

    expect(session.getEntry(c.id)?.parentId).toBe(b.id);
    expect(d.parentId).toBe(b.id);
    expect(session.getBranch().map((entry) => entry.id)).toEqual([a.id, b.id, d.id]);
    expect(session.getEntries().map((entry) => entry.id)).toEqual([a.id, b.id, c.id, d.id]);
    expect(() => session.branch('missing')).toThrow('Session entry not found: missing');
  });

  it('builds context from the current branch and applies branch-local settings', () => {
    const session = SessionManager.inMemory();
    const root = session.appendMessage(userMessage('root'));
    session.appendModelChange('provider-a', 'model-a');
    const branchPoint = session.appendThinkingLevelChange('low');
    session.appendMessage(assistantMessage('main'));
    session.appendModelChange('provider-main', 'model-main');
    session.appendThinkingLevelChange('high');

    expect(session.buildSessionContext().model).toEqual({
      provider: 'provider-main',
      modelId: 'model-main',
    });
    expect(session.buildSessionContext().thinkingLevel).toBe('high');

    session.branch(branchPoint.id);
    session.appendMessage(assistantMessage('branch'));
    session.appendModelChange('provider-branch', 'model-branch');

    const context = session.buildSessionContext();
    expect(context.messages.map((message) => (message as { role: string }).role)).toEqual([
      'user',
      'assistant',
    ]);
    expect((context.messages[0] as { content: readonly { text: string }[] }).content[0].text).toBe(
      'root',
    );
    expect((context.messages[1] as { content: readonly { text: string }[] }).content[0].text).toBe(
      'branch',
    );
    expect(context.model).toEqual({ provider: 'provider-branch', modelId: 'model-branch' });
    expect(context.thinkingLevel).toBe('low');
  });

  it('projects the latest compaction summary and keeps the original message entries', () => {
    const session = SessionManager.inMemory();
    const first = session.appendMessage(userMessage('A'));
    const second = session.appendMessage(assistantMessage('B'));
    const third = session.appendMessage(userMessage('C'));
    const fourth = session.appendMessage(assistantMessage('D'));
    const fifth = session.appendMessage(userMessage('E'));
    const sixth = session.appendMessage(assistantMessage('F'));
    const firstCompaction = session.appendCompaction('summary one', fifth.id, 42);

    expect(firstCompaction.parentId).toBe(sixth.id);
    expect(session.buildSessionContext().messages).toEqual([
      createCompactionSummaryMessage('summary one'),
      fifth.message,
      sixth.message,
    ]);
    expect(session.getEntries()).toEqual([
      first,
      second,
      third,
      fourth,
      fifth,
      sixth,
      firstCompaction,
    ]);

    const seventh = session.appendMessage(userMessage('G'));
    const eighth = session.appendMessage(assistantMessage('H'));
    expect(session.buildSessionContext().messages).toEqual([
      createCompactionSummaryMessage('summary one'),
      fifth.message,
      sixth.message,
      seventh.message,
      eighth.message,
    ]);

    const secondCompaction = session.appendCompaction('summary two', seventh.id, 84);
    expect(session.buildSessionContext().messages).toEqual([
      createCompactionSummaryMessage('summary two'),
      seventh.message,
      eighth.message,
    ]);
    expect(session.getEntries()).toHaveLength(10);
    expect(session.getEntries().filter((entry) => entry.type === 'message')).toHaveLength(8);
    expect(session.getEntries().filter((entry) => entry.type === 'compaction')).toEqual([
      firstCompaction,
      secondCompaction,
    ]);
  });

  it('does not apply a compaction from a different branch', () => {
    const session = SessionManager.inMemory();
    const first = session.appendMessage(userMessage('A'));
    const second = session.appendMessage(assistantMessage('B'));
    const third = session.appendMessage(userMessage('C'));
    const compaction = session.appendCompaction('summary', second.id, 10);

    session.branch(third.id);

    expect(session.buildSessionContext().messages).toEqual([first.message, second.message, third.message]);
    expect(compaction.parentId).toBe(third.id);
  });

  it('rejects invalid compaction references and values without appending an entry', () => {
    const session = SessionManager.inMemory();
    const message = session.appendMessage(userMessage('A'));
    const entryCount = session.getEntries().length;

    expect(() => session.appendCompaction('', message.id, 0)).toThrow(
      'Compaction summary must be non-empty',
    );
    expect(() => session.appendCompaction('summary', 'missing', 0)).toThrow(
      'Session entry not found: missing',
    );
    expect(() => session.appendCompaction('summary', message.id, -1)).toThrow(
      'tokensBefore must be a non-negative integer',
    );
    expect(session.getEntries()).toHaveLength(entryCount);
  });
});

describe('SessionManager JSONL persistence', () => {
  it('creates, appends, loads, and resumes a session without rewriting history', () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, 'session.jsonl');
    const session = SessionManager.createPersisted(filePath, {
      id: 'session-persisted',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const first = session.appendMessage(userMessage('first'));
    const second = session.appendMessage(assistantMessage('second'));
    session.appendModelChange('provider', 'model');

    const initialLines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(initialLines).toHaveLength(4);
    expect(JSON.parse(initialLines[0])).toMatchObject({
      type: 'session',
      version: 1,
      id: 'session-persisted',
    });

    const loaded = SessionManager.load(filePath);
    expect(loaded.getHeader()).toEqual(session.getHeader());
    expect(loaded.getEntries()).toEqual(session.getEntries());
    expect(loaded.getLeafId()).toBe(session.getLeafId());
    expect(loaded.getBranch().map((entry) => entry.id)).toEqual([
      first.id,
      second.id,
      session.getLeafId(),
    ]);
    expect(loaded.buildSessionContext().model).toEqual({ provider: 'provider', modelId: 'model' });

    const resumed = loaded.appendMessage(userMessage('resumed'));
    expect(resumed.parentId).toBe(session.getLeafId());
    const reloaded = SessionManager.load(filePath);
    expect(reloaded.getLeafId()).toBe(resumed.id);
    expect(reloaded.getEntry(resumed.id)?.parentId).toBe(session.getLeafId());
  });

  it('serializes and reloads CompactionEntry without removing original messages', () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, 'session-with-compaction.jsonl');
    const session = SessionManager.createPersisted(filePath, {
      id: 'session-compaction',
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    const first = session.appendMessage(userMessage('old'));
    const kept = session.appendMessage(assistantMessage('kept'));
    const compaction = session.appendCompaction('summary', kept.id, 123);

    const loaded = SessionManager.load(filePath);

    expect(loaded.getEntries()).toEqual([first, kept, compaction]);
    expect(loaded.getLeafId()).toBe(compaction.id);
    expect(loaded.buildSessionContext().messages).toEqual([
      createCompactionSummaryMessage('summary'),
      kept.message,
    ]);
    expect(readFileSync(filePath, 'utf8')).toContain('"type":"compaction"');
  });
});

describe('SessionManager invalid JSONL files', () => {
  it('rejects missing, empty, malformed, unsupported, duplicate, and invalid-order files', () => {
    const directory = temporaryDirectory();
    const missing = join(directory, 'missing.jsonl');
    expect(() => SessionManager.load(missing)).toThrow('Session file does not exist');

    const cases: Array<[string, string, string]> = [
      ['empty.jsonl', '', 'Session file is empty'],
      [
        'invalid-header.jsonl',
        '{"type":"message"}\n',
        'First session record must be a session header',
      ],
      ['invalid-json.jsonl', '{not-json}\n', 'Invalid JSON in session file'],
      [
        'unsupported-version.jsonl',
        '{"type":"session","version":2,"id":"s","timestamp":"2026-01-01T00:00:00.000Z"}\n',
        'Unsupported session version: 2',
      ],
      [
        'duplicate.jsonl',
        [
          { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
          {
            type: 'message',
            id: 'a',
            parentId: null,
            timestamp: '2026-01-01T00:00:01.000Z',
            message: userMessage('a'),
          },
          {
            type: 'message',
            id: 'a',
            parentId: 'a',
            timestamp: '2026-01-01T00:00:02.000Z',
            message: userMessage('b'),
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
        'Duplicate session entry id: a',
      ],
      [
        'cycle.jsonl',
        [
          { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
          {
            type: 'message',
            id: 'root',
            parentId: null,
            timestamp: '2026-01-01T00:00:01.000Z',
            message: userMessage('root'),
          },
          {
            type: 'message',
            id: 'a',
            parentId: 'b',
            timestamp: '2026-01-01T00:00:02.000Z',
            message: userMessage('a'),
          },
          {
            type: 'message',
            id: 'b',
            parentId: 'a',
            timestamp: '2026-01-01T00:00:03.000Z',
            message: userMessage('b'),
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
        'parent that has not appeared yet',
      ],
      [
        'invalid-thinking-level.jsonl',
        [
          { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
          {
            type: 'thinking_level_change',
            id: 'thinking',
            parentId: null,
            timestamp: '2026-01-01T00:00:01.000Z',
            thinkingLevel: 'ultra',
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
        'invalid thinkingLevel',
      ],
      [
        'invalid-compaction-summary.jsonl',
        [
          { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
          {
            type: 'compaction',
            id: 'compaction',
            parentId: null,
            timestamp: '2026-01-01T00:00:01.000Z',
            summary: ' ',
            firstKeptEntryId: 'message',
            tokensBefore: 0,
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
        'invalid summary',
      ],
      [
        'invalid-compaction-first-kept.jsonl',
        [
          { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
          {
            type: 'compaction',
            id: 'compaction',
            parentId: null,
            timestamp: '2026-01-01T00:00:01.000Z',
            summary: 'summary',
            firstKeptEntryId: ' ',
            tokensBefore: 0,
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
        'invalid firstKeptEntryId',
      ],
      [
        'invalid-compaction-tokens.jsonl',
        [
          { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
          {
            type: 'compaction',
            id: 'compaction',
            parentId: null,
            timestamp: '2026-01-01T00:00:01.000Z',
            summary: 'summary',
            firstKeptEntryId: 'message',
            tokensBefore: -1,
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join('\n') + '\n',
        'invalid tokensBefore',
      ],
    ];

    for (const [name, content, expectedError] of cases) {
      const filePath = join(directory, name);
      writeFileSync(filePath, content, 'utf8');
      expect(() => SessionManager.load(filePath), name).toThrow(expectedError);
    }
  });

  it('rejects a forward parent reference and a second root', () => {
    const directory = temporaryDirectory();
    const header = { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' };
    const root = {
      type: 'message',
      id: 'A',
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: userMessage('A'),
    };

    const forwardParentPath = join(directory, 'forward-parent.jsonl');
    writeFileSync(
      forwardParentPath,
      [
        header,
        root,
        {
          type: 'message',
          id: 'C',
          parentId: 'D',
          timestamp: '2026-01-01T00:00:02.000Z',
          message: userMessage('C'),
        },
        {
          type: 'message',
          id: 'D',
          parentId: 'A',
          timestamp: '2026-01-01T00:00:03.000Z',
          message: userMessage('D'),
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf8',
    );
    expect(() => SessionManager.load(forwardParentPath)).toThrow(
      'Session entry C references a parent that has not appeared yet: D',
    );

    const secondRootPath = join(directory, 'second-root.jsonl');
    writeFileSync(
      secondRootPath,
      [
        header,
        root,
        {
          type: 'message',
          id: 'B',
          parentId: null,
          timestamp: '2026-01-01T00:00:02.000Z',
          message: userMessage('B'),
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
      'utf8',
    );
    expect(() => SessionManager.load(secondRootPath)).toThrow(
      'Session entry B has parentId=null after the first entry',
    );
  });

  it('loads a valid branch whose parent appeared earlier in the file', () => {
    const directory = temporaryDirectory();
    const filePath = join(directory, 'valid-branch.jsonl');
    const records = [
      { type: 'session', version: 1, id: 's', timestamp: '2026-01-01T00:00:00.000Z' },
      {
        type: 'message',
        id: 'A',
        parentId: null,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: userMessage('A'),
      },
      {
        type: 'message',
        id: 'B',
        parentId: 'A',
        timestamp: '2026-01-01T00:00:02.000Z',
        message: assistantMessage('B'),
      },
      {
        type: 'message',
        id: 'C',
        parentId: 'B',
        timestamp: '2026-01-01T00:00:03.000Z',
        message: userMessage('C'),
      },
      {
        type: 'message',
        id: 'D',
        parentId: 'B',
        timestamp: '2026-01-01T00:00:04.000Z',
        message: userMessage('D'),
      },
    ];
    writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');

    const session = SessionManager.load(filePath);
    expect(session.getLeafId()).toBe('D');
    expect(session.getBranch().map((entry) => entry.id)).toEqual(['A', 'B', 'D']);
    expect(session.getEntries().map((entry) => entry.id)).toEqual(['A', 'B', 'C', 'D']);
  });
});
