/** Coordinates application-level work that must be serialized per session. */
export interface SessionRunCoordinator {
  runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T>;
}

interface SessionQueue {
  tail: Promise<void>;
  pending: number;
}

/** Serializes operations by session id while allowing different sessions to run concurrently. */
export class InMemorySessionRunCoordinator implements SessionRunCoordinator {
  private readonly queues = new Map<string, SessionQueue>();

  /** Runs an operation after earlier work for the same session has completed. */
  public runExclusive<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const queue = this.queues.get(sessionId) ?? { tail: Promise.resolve(), pending: 0 };
    queue.pending += 1;
    this.queues.set(sessionId, queue);

    const predecessor = queue.tail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    queue.tail = predecessor.then(
      () => gate,
      () => gate,
    );

    return predecessor
      .then(
        () => operation(),
        () => operation(),
      )
      .finally(() => {
        release();
        queue.pending -= 1;
        if (queue.pending === 0) this.queues.delete(sessionId);
      });
  }
}
