import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { Turn, type TurnCheckpoint, type TurnEvent } from '@opspilot/domain';
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

function eventId(sequence: number, attempt: number): string {
  return `event-${attempt}-${sequence}`;
}

function turnStartedEvent(
  turn: Turn,
  sequence = 0,
  attempt = turn.getState().attempt,
): TurnEvent {
  return {
    version: 1,
    id: eventId(sequence, attempt),
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: startedAt,
    type: 'turn_started',
  };
}

function modelStartedEvent(
  turn: Turn,
  sequence: number,
  attempt = turn.getState().attempt,
): TurnEvent {
  return {
    version: 1,
    id: eventId(sequence, attempt),
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: startedAt,
    type: 'model_started',
  };
}

function modelCompletedEvent(
  turn: Turn,
  sequence = 1,
  attempt = turn.getState().attempt,
): TurnEvent {
  return {
    version: 1,
    id: eventId(sequence, attempt),
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'model_completed',
  };
}

function inputCommittedEvent(
  turn: Turn,
  sequence = 0,
  attempt = turn.getState().attempt,
): TurnEvent {
  return {
    version: 1,
    id: eventId(sequence, attempt),
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: startedAt,
    type: 'input_committed',
    entryId: 'entry-1',
    sessionLeafId: 'leaf-1',
  };
}

function assistantMessageCompletedEvent(
  turn: Turn,
  sequence = 0,
  attempt = turn.getState().attempt,
): TurnEvent {
  return {
    version: 1,
    id: eventId(sequence, attempt),
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'assistant_message_completed',
    entryId: 'entry-2',
    sessionLeafId: 'leaf-2',
  };
}

function toolRequestedEvent(
  turn: Turn,
  sequence = 0,
  attempt = turn.getState().attempt,
): TurnEvent {
  return {
    version: 1,
    id: eventId(sequence, attempt),
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: '2026-01-01T00:00:02.000Z',
    type: 'tool_requested',
    callId: 'call-1',
    name: 'lookup',
  };
}

function toolCompletedEvent(
  turn: Turn,
  sequence = 0,
  attempt = turn.getState().attempt,
): TurnEvent {
  return {
    version: 1,
    id: eventId(sequence, attempt),
    turnId: turn.getId(),
    sessionId: turn.getSessionId(),
    sequence,
    attempt,
    timestamp: '2026-01-01T00:00:03.000Z',
    type: 'tool_completed',
    callId: 'call-1',
    name: 'lookup',
    isError: false,
    resultEntryId: 'entry-3',
    sessionLeafId: 'leaf-3',
  };
}

function writeEvents(root: string, turnId: string, events: readonly TurnEvent[]): void {
  writeFileSync(
    join(root, 'turns', turnId, 'events.jsonl'),
    `${events.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );
}

function overwriteCheckpoint(
  root: string,
  turnId: string,
  checkpoint: TurnCheckpoint,
): void {
  const metadataPath = join(root, 'turns', turnId, 'metadata.json');
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as Record<string, unknown>;
  metadata.checkpoint = checkpoint;
  writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`, 'utf8');
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

  it('accepts valid attempt histories, including a resume crash window', () => {
    const initial = createStore();
    const initialTurn = createStartedTurn('turn-initial');
    initial.store.create(initialTurn);
    initial.store.appendEvent(initialTurn.getId(), turnStartedEvent(initialTurn));
    initial.store.appendEvent(initialTurn.getId(), modelStartedEvent(initialTurn, 1));
    initial.store.appendEvent(initialTurn.getId(), modelCompletedEvent(initialTurn, 2));
    expect(initial.store.load(initialTurn.getId()).getState().attempt).toBe(1);

    const resumed = createStore();
    const resumedTurn = Turn.restore({ ...createStartedTurn('turn-resumed').getState(), attempt: 2 });
    resumed.store.create(resumedTurn);
    writeEvents(resumed.root, resumedTurn.getId(), [
      turnStartedEvent(resumedTurn, 0, 1),
      modelStartedEvent(resumedTurn, 1, 1),
      modelCompletedEvent(resumedTurn, 2, 2),
      modelStartedEvent(resumedTurn, 3, 2),
    ]);
    expect(resumed.store.load(resumedTurn.getId()).getState().attempt).toBe(2);

    const crashWindow = createStore();
    const crashTurn = Turn.restore({ ...createStartedTurn('turn-crash').getState(), attempt: 2 });
    crashWindow.store.create(crashTurn);
    writeEvents(crashWindow.root, crashTurn.getId(), [
      turnStartedEvent(crashTurn, 0, 1),
      modelStartedEvent(crashTurn, 1, 1),
    ]);
    expect(crashWindow.store.load(crashTurn.getId()).getState().attempt).toBe(2);
  });

  it.each([
    ['backwards', 2, [1, 2, 1]],
    ['jump', 3, [1, 3]],
    ['future attempt', 2, [3]],
    ['first event after attempt one', 2, [2]],
  ] as const)('rejects %s attempt history', (_case, metadataAttempt, attempts) => {
    const { root, store } = createStore();
    const turn = Turn.restore({ ...createStartedTurn().getState(), attempt: metadataAttempt });
    store.create(turn);
    writeEvents(
      root,
      turn.getId(),
      attempts.map((attempt, sequence) => modelStartedEvent(turn, sequence, attempt)),
    );

    expect(() => store.load(turn.getId())).toThrow(TurnStoreError);
  });

  it.each([
    ['input_committed', inputCommittedEvent],
    ['assistant_committed', assistantMessageCompletedEvent],
    ['tool_completed', toolCompletedEvent],
  ] as const)('accepts checkpoint phase %s only for its durable event', (phase, createEvent) => {
    const { root, store } = createStore();
    const turn = createStartedTurn();
    store.create(turn);
    store.appendEvent(turn.getId(), createEvent(turn));
    turn.advanceCheckpoint({ eventSequence: 0, sessionLeafId: 'leaf-1', phase });
    store.save(turn);

    expect(store.load(turn.getId()).getState().checkpoint?.phase).toBe(phase);
  });

  it.each([
    ['input_committed', (turn: Turn) => modelStartedEvent(turn, 0)],
    ['assistant_committed', (turn: Turn) => modelCompletedEvent(turn, 0)],
    ['tool_completed', (turn: Turn) => toolRequestedEvent(turn, 0)],
  ] as const)('rejects checkpoint phase %s for the wrong event', (phase, createEvent) => {
    const { root, store } = createStore();
    const turn = createStartedTurn();
    store.create(turn);
    store.appendEvent(turn.getId(), createEvent(turn));
    overwriteCheckpoint(root, turn.getId(), {
      eventSequence: 0,
      sessionLeafId: 'leaf-1',
      phase,
    });

    expect(() => store.load(turn.getId())).toThrow(TurnStoreError);
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
