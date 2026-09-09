import {
  applyTurnStreamEvent,
  createInitialTurnStreamProjection,
  TurnStreamNotFoundError,
  TurnStreamReplayGapError,
  TurnStreamSessionConflictError,
  type ActiveTurnStreamSnapshot,
  type OpenTurnStreamInput,
  type TurnStreamEvent,
  type TurnStreamEventDraft,
  type TurnStreamHub,
  type TurnStreamProjection,
} from '@opspilot/application';

const DEFAULT_REPLAY_CAPACITY = 256;

interface Subscriber {
  readonly queue: TurnStreamEvent[];
  readonly waiters: Array<(result: IteratorResult<TurnStreamEvent>) => void>;
  closed: boolean;
}

interface TurnChannel {
  readonly turnId: string;
  readonly sessionId: string;
  nextSequence: number;
  projection: TurnStreamProjection;
  readonly replayBuffer: TurnStreamEvent[];
  readonly subscribers: Set<Subscriber>;
  closed: boolean;
}

/** In-process live Turn delivery. Projection and replay data are intentionally ephemeral. */
export class InMemoryTurnStreamHub implements TurnStreamHub {
  private readonly channels = new Map<string, TurnChannel>();
  private readonly activeTurnBySession = new Map<string, string>();
  private readonly replayCapacity: number;

  public constructor(
    options?: number | { readonly replayCapacity?: number; readonly capacity?: number },
  ) {
    const capacity =
      typeof options === 'number'
        ? options
        : (options?.replayCapacity ?? options?.capacity ?? DEFAULT_REPLAY_CAPACITY);
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Turn stream replay capacity must be a positive integer.');
    }
    this.replayCapacity = capacity;
  }

  public openTurn(input: OpenTurnStreamInput): void {
    const activeTurnId = this.activeTurnBySession.get(input.sessionId);
    if (activeTurnId !== undefined && activeTurnId !== input.turnId) {
      throw new TurnStreamSessionConflictError(input.sessionId, activeTurnId);
    }

    const existing = this.channels.get(input.turnId);
    if (existing !== undefined) {
      if (existing.sessionId !== input.sessionId || existing.closed) {
        throw new Error(`Turn stream channel ${input.turnId} is already open or closed.`);
      }
      return;
    }

    const channel: TurnChannel = {
      turnId: input.turnId,
      sessionId: input.sessionId,
      nextSequence: 0,
      projection: createInitialTurnStreamProjection(input),
      replayBuffer: [],
      subscribers: new Set(),
      closed: false,
    };
    this.channels.set(input.turnId, channel);
    this.activeTurnBySession.set(input.sessionId, input.turnId);
  }

  public publish(event: TurnStreamEventDraft): TurnStreamEvent {
    return this.publishDraft(event);
  }

  public publishDraft(event: TurnStreamEventDraft): TurnStreamEvent {
    const channel = this.requireChannel(event.turnId);
    if (channel.closed) throw new Error(`Turn stream channel ${event.turnId} is closed.`);
    if (event.sessionId !== channel.sessionId) {
      throw new Error(`Turn stream event sessionId does not match Turn ${event.turnId}.`);
    }

    const { timestamp, ...payload } = event;
    const published = {
      ...payload,
      sequence: channel.nextSequence,
      timestamp: timestamp ?? new Date().toISOString(),
    } as TurnStreamEvent;
    channel.nextSequence += 1;
    channel.projection = applyTurnStreamEvent(channel.projection, published);
    channel.replayBuffer.push(published);
    if (channel.replayBuffer.length > this.replayCapacity) channel.replayBuffer.shift();

    for (const subscriber of channel.subscribers) this.enqueue(subscriber, published);

    if (
      published.type === 'turn_completed' ||
      published.type === 'turn_failed' ||
      published.type === 'turn_cancelled'
    ) {
      this.closeChannel(channel);
    }
    return published;
  }

  public getActiveTurn(sessionId: string): ActiveTurnStreamSnapshot | null {
    const turnId = this.activeTurnBySession.get(sessionId);
    if (turnId === undefined) return null;
    const channel = this.channels.get(turnId);
    if (channel === undefined || channel.closed) return null;
    return {
      turnId: channel.turnId,
      sessionId: channel.sessionId,
      status: 'running',
      projection: cloneProjection(channel.projection),
    };
  }

  public getProjection(turnId: string): TurnStreamProjection | null {
    const channel = this.channels.get(turnId);
    return channel === undefined ? null : cloneProjection(channel.projection);
  }

  public subscribe(turnId: string, afterSequence?: number): AsyncIterable<TurnStreamEvent> {
    const channel = this.requireChannel(turnId);
    if (afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < -1)) {
      throw new Error('Turn stream afterSequence must be an integer greater than or equal to -1.');
    }

    const subscriber: Subscriber = { queue: [], waiters: [], closed: false };
    const replayFrom = afterSequence === undefined ? undefined : afterSequence;
    if (replayFrom !== undefined && channel.replayBuffer.length > 0) {
      const oldestAvailable = channel.replayBuffer[0]!.sequence;
      const latestAvailable = channel.replayBuffer.at(-1)!.sequence;
      if (replayFrom < oldestAvailable - 1) {
        throw new TurnStreamReplayGapError(replayFrom, oldestAvailable, latestAvailable);
      }
    }

    // Registration and replay seeding are synchronous. A publish cannot run between them
    // in Node's event loop, so projection -> subscribe(afterSequence) has no gap.
    channel.subscribers.add(subscriber);
    const replay = channel.replayBuffer.filter(
      (event) => replayFrom === undefined || event.sequence > replayFrom,
    );
    subscriber.queue.push(...replay);
    if (channel.closed) this.finishSubscriber(channel, subscriber);

    const hub = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<TurnStreamEvent> {
        return {
          next(): Promise<IteratorResult<TurnStreamEvent>> {
            const event = subscriber.queue.shift();
            if (event !== undefined) return Promise.resolve({ value: event, done: false });
            if (subscriber.closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve) => subscriber.waiters.push(resolve));
          },
          return(): Promise<IteratorResult<TurnStreamEvent>> {
            hub.unsubscribe(channel, subscriber);
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  public closeTurn(turnId: string): void {
    const channel = this.channels.get(turnId);
    if (channel === undefined) return;
    this.closeChannel(channel);
  }

  private requireChannel(turnId: string): TurnChannel {
    const channel = this.channels.get(turnId);
    if (channel === undefined) throw new TurnStreamNotFoundError(turnId);
    return channel;
  }

  private enqueue(subscriber: Subscriber, event: TurnStreamEvent): void {
    if (subscriber.closed) return;
    const waiter = subscriber.waiters.shift();
    if (waiter !== undefined) waiter({ value: event, done: false });
    else subscriber.queue.push(event);
  }

  private closeChannel(channel: TurnChannel): void {
    if (channel.closed) return;
    channel.closed = true;
    if (this.activeTurnBySession.get(channel.sessionId) === channel.turnId) {
      this.activeTurnBySession.delete(channel.sessionId);
    }
    for (const subscriber of [...channel.subscribers]) {
      this.finishSubscriber(channel, subscriber);
    }
    this.deleteIfUnsubscribed(channel);
  }

  private finishSubscriber(channel: TurnChannel, subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    for (const waiter of subscriber.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
    channel.subscribers.delete(subscriber);
    this.deleteIfUnsubscribed(channel);
  }

  private unsubscribe(channel: TurnChannel, subscriber: Subscriber): void {
    if (!subscriber.closed) {
      subscriber.closed = true;
      subscriber.queue.length = 0;
      for (const waiter of subscriber.waiters.splice(0)) {
        waiter({ value: undefined, done: true });
      }
    }
    channel.subscribers.delete(subscriber);
    this.deleteIfUnsubscribed(channel);
  }

  private deleteIfUnsubscribed(channel: TurnChannel): void {
    if (channel.closed && channel.subscribers.size === 0) this.channels.delete(channel.turnId);
  }
}

function cloneProjection(projection: TurnStreamProjection): TurnStreamProjection {
  return {
    ...projection,
    assistant: { ...projection.assistant },
    tools: projection.tools.map((tool) => ({ ...tool })),
    compaction: { ...projection.compaction },
    usage: projection.usage === null ? null : { ...projection.usage },
  };
}
