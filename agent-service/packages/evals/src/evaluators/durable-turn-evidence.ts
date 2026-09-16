import type {
  Session,
  SessionAssistantMessage,
  ToolCompletedEvent,
  Turn,
  TurnEvent,
} from '@opspilot/application';

/** The smallest durable Turn read surface required by deterministic evaluators. */
export interface DurableTurnReader {
  load(turnId: string): Turn;
  loadEvents(turnId: string): readonly TurnEvent[];
}

/** The smallest durable Session read surface required by deterministic evaluators. */
export interface DurableSessionReader {
  load(sessionId: string): Session;
}

/** Dependencies for resolving an Excel evaluator's durable execution evidence. */
export interface DurableTurnEvidenceReaderOptions {
  readonly turns: DurableTurnReader;
  readonly sessions: DurableSessionReader;
}

/** Eval-local projection of one completed Turn's durable outcome evidence. */
export interface DurableExcelEvidence {
  readonly turnId: string;
  readonly sessionId: string;
  readonly events: readonly TurnEvent[];
  readonly toolEvents: readonly ToolCompletedEvent[];
  readonly finalAssistant: SessionAssistantMessage;
  readonly finalAssistantEntryId: string;
}

/** A deterministic failure raised when the durable evidence chain is incomplete. */
export class DurableTurnEvidenceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DurableTurnEvidenceError';
  }
}

/** Loads and resolves the complete Turn -> events -> Session -> assistant evidence chain. */
export function loadDurableExcelEvidence(
  turnId: string,
  options: DurableTurnEvidenceReaderOptions,
): DurableExcelEvidence {
  const turn = options.turns.load(turnId);
  if (turn.getId() !== turnId) {
    throw new DurableTurnEvidenceError(
      `Durable Turn reader returned ${turn.getId()} while loading ${turnId}.`,
    );
  }
  const events = options.turns.loadEvents(turnId);
  const sessionId = turn.getSessionId();
  const turnState = turn.getState();
  const toolEvents = events.filter(
    (event): event is ToolCompletedEvent =>
      event.type === 'tool_completed' &&
      event.turnId === turnId &&
      event.sessionId === sessionId,
  );

  if (turnState.status !== 'completed') {
    throw new DurableTurnEvidenceError('Durable Turn did not complete successfully.');
  }

  const terminalEvent = findLastTurnCompletedEvent(events, turnId, sessionId, turnState.attempt);
  if (terminalEvent === undefined) {
    throw new DurableTurnEvidenceError(
      'Completed Turn does not have a durable turn_completed event.',
    );
  }
  if (terminalEvent.resultLeafId === null) {
    throw new DurableTurnEvidenceError(
      'Completed Turn does not reference a durable result leaf.',
    );
  }

  const assistantEvent = events.find(
    (event): event is Extract<TurnEvent, { type: 'assistant_message_completed' }> =>
      event.type === 'assistant_message_completed' &&
      event.turnId === turnId &&
      event.sessionId === sessionId &&
      event.attempt === terminalEvent.attempt &&
      event.entryId === terminalEvent.resultLeafId,
  );
  if (assistantEvent === undefined) {
    throw new DurableTurnEvidenceError(
      'Completed Turn result leaf is not backed by a durable assistant_message_completed event.',
    );
  }

  const session = options.sessions.load(sessionId);
  if (session.getId() !== sessionId) {
    throw new DurableTurnEvidenceError(
      `Durable Turn ${turnId} references Session ${sessionId}, but the loaded Session has id ${session.getId()}.`,
    );
  }

  const entry = session.getEntry(terminalEvent.resultLeafId);
  if (entry?.type !== 'message' || entry.message.role !== 'assistant') {
    throw new DurableTurnEvidenceError(
      'Completed Turn result leaf does not reference a durable assistant message.',
    );
  }
  if (entry.id !== assistantEvent.entryId) {
    throw new DurableTurnEvidenceError(
      'Durable assistant_message_completed evidence does not match the Session result entry.',
    );
  }
  if (entry.message.finishReason !== 'stop') {
    throw new DurableTurnEvidenceError(
      'The durable Turn result does not reference a successful final assistant answer.',
    );
  }

  return {
    turnId,
    sessionId,
    events,
    toolEvents,
    finalAssistant: entry.message,
    finalAssistantEntryId: entry.id,
  };
}

/** Extracts only visible text content from the durable assistant message. */
export function extractAssistantText(message: SessionAssistantMessage): string {
  return message.content
    .filter((content): content is Extract<typeof content, { type: 'text' }> => content.type === 'text')
    .map((content) => content.text)
    .join('\n');
}

/** Finds the terminal completion event for the Turn's current attempt. */
function findLastTurnCompletedEvent(
  events: readonly TurnEvent[],
  turnId: string,
  sessionId: string,
  attempt: number,
): Extract<TurnEvent, { type: 'turn_completed' }> | undefined {
  return [...events]
    .reverse()
    .find(
      (event): event is Extract<TurnEvent, { type: 'turn_completed' }> =>
        event.type === 'turn_completed' &&
        event.turnId === turnId &&
        event.sessionId === sessionId &&
        event.attempt === attempt,
    );
}
