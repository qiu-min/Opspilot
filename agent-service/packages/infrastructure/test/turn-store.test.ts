import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Turn, type TurnEvent } from '@opspilot/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { FileSystemTurnStore, TurnStoreError } from '../src/index.js';

const createdAt = '2026-01-01T00:00:00.000Z';
const startedAt = '2026-01-01T00:00:01.000Z';

const directories: string[] = [];

function createStore(): { root: string; store: FileSystemTurnStore } {
  const root = mkdtempSync(join(tmpdir(), 'opspilot-turn-store-'));
  directories.push(root);
  return { root, store: new FileSystemTurnStore(root) };
}

function createStartedTurn(id = 'turn-1', sessionId = 'session-1'): Turn {
  const turn = Turn.create({ id, sessionId, createdAt });
  turn.start(startedAt);
  return turn;
}

function turnStartedEvent(turn: Turn, sequence = 0): TurnEvent {
  return {
    version: 1,
    id: `event-${sequence}`,
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt: turn.getState().attempt,
    timestamp: startedAt,
    type: 'turn_started',
  };
}

function modelCompletedEvent(turn: Turn, sequence = 1): TurnEvent {
  return {
    version: 1,
    id: `event-${sequence}`,
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt: turn.getState().attempt,
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'model_completed',
  };
}

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

describe('FileSystemTurnStore', () => {
  it('creates, saves, reloads, and preserves the expected filesystem layout', () => {
    const { root, store } = createStore();
    const turn = Turn.create({ id: 'turn-1', sessionId: 'session-1', createdAt });

    store.create(turn);
    turn.start(startedAt);
    store.save(turn);

    expect(readFileSync(join(root, 'turns', 'turn-1', 'metadata.json'), 'utf8')).toContain(
      '"status": "running"',
    );
    expect(readFileSync(join(root, 'turns', 'turn-1', 'events.jsonl'), 'utf8')).toBe('');
    expect(store.load('turn-1').getState()).toEqual(turn.getState());
  });

  it('appends ordered events and reloads them without rewriting history', () => {
    const { root, store } = createStore();
    const turn = createStartedTurn();
    store.create(turn);
    store.save(turn);

    store.appendEvent(turn.getId(), turnStartedEvent(turn));
    const before = readFileSync(join(root, 'turns', 'turn-1', 'events.jsonl'));
    store.appendEvent(turn.getId(), modelCompletedEvent(turn));
    const after = readFileSync(join(root, 'turns', 'turn-1', 'events.jsonl'));

    expect(after.subarray(0, before.length)).toEqual(before);
    expect(store.loadEvents(turn.getId()).map((event) => event.sequence)).toEqual([0, 1]);
  });

  it.each([
    ['duplicate sequence', (turn: Turn) => turnStartedEvent(turn, 0)],
    ['skipped sequence', (turn: Turn) => modelCompletedEvent(turn, 2)],
    ['wrong turn id', (turn: Turn) => ({ ...turnStartedEvent(turn), turnId: 'other-turn' })],
    ['wrong session id', (turn: Turn) => ({ ...turnStartedEvent(turn), sessionId: 'other-session' })],
    ['wrong attempt', (turn: Turn) => ({ ...turnStartedEvent(turn), attempt: 2 })],
  ] as const)('rejects %s', (_case, buildEvent) => {
    const { store } = createStore();
    const turn = createStartedTurn();
    store.create(turn);
    store.save(turn);
    store.appendEvent(turn.getId(), turnStartedEvent(turn));

    expect(() => store.appendEvent(turn.getId(), buildEvent(turn))).toThrow(TurnStoreError);
  });

  it('lists Turns by Session and lists running or interrupted Turns as recoverable', () => {
    const { store } = createStore();
    const turn1 = createStartedTurn('turn-1', 'session-a');
    const turn2 = createStartedTurn('turn-2', 'session-a');
    const turn3 = createStartedTurn('turn-3', 'session-b');
    store.create(turn1);
    store.create(turn2);
    store.create(turn3);
    store.save(turn1);
    store.save(turn2);
    store.save(turn3);
    turn2.markInterrupted('2026-01-01T00:00:03.000Z');
    store.save(turn2);
    turn3.complete(null, '2026-01-01T00:00:03.000Z');
    store.save(turn3);

    expect(store.listBySession('session-a').map((turn) => turn.getId())).toEqual([
      'turn-1',
      'turn-2',
    ]);
    expect(store.listRecoverable().map((turn) => turn.getId())).toEqual(['turn-1', 'turn-2']);
  });

  it('rejects malformed event files and incomplete layouts', () => {
    const { root, store } = createStore();
    const turn = createStartedTurn();
    store.create(turn);
    store.save(turn);

    writeFileSync(join(root, 'turns', 'turn-1', 'metadata.json'), '{not-json', 'utf8');
    expect(() => store.load(turn.getId())).toThrow(TurnStoreError);

    writeFileSync(
      join(root, 'turns', 'turn-1', 'metadata.json'),
      JSON.stringify({ version: 1, id: turn.getId() }),
      'utf8',
    );
    expect(() => store.load(turn.getId())).toThrow(TurnStoreError);

    store.save(turn);
    writeFileSync(
      join(root, 'turns', 'turn-1', 'events.jsonl'),
      '{"version":1,"type":"unsupported"}\n',
      'utf8',
    );
    expect(() => store.loadEvents(turn.getId())).toThrow(TurnStoreError);

    writeFileSync(join(root, 'turns', 'turn-1', 'events.jsonl'), '{not-json\n', 'utf8');
    expect(() => store.loadEvents(turn.getId())).toThrow(TurnStoreError);

    rmSync(join(root, 'turns', 'turn-1', 'events.jsonl'));
    expect(() => store.load(turn.getId())).toThrow(TurnStoreError);

    writeFileSync(join(root, 'turns', 'turn-1', 'events.jsonl'), '', 'utf8');
    rmSync(join(root, 'turns', 'turn-1', 'metadata.json'));
    expect(() => store.load(turn.getId())).toThrow(TurnStoreError);
  });
});
