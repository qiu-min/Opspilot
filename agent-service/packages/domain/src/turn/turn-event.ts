import { TurnEventError } from './turn-errors.js';

/** Current durable TurnEvent record version. */
export const CURRENT_TURN_EVENT_VERSION = 1 as const;

/** Common fields present on every append-only TurnEvent. */
export interface TurnEventBase {
  readonly version: typeof CURRENT_TURN_EVENT_VERSION;
  readonly id: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly attempt: number;
  readonly timestamp: string;
}

export interface TurnStartedEvent extends TurnEventBase {
  readonly type: 'turn_started';
}

export interface ModelStartedEvent extends TurnEventBase {
  readonly type: 'model_started';
}

export interface ModelCompletedEvent extends TurnEventBase {
  readonly type: 'model_completed';
}

export interface InputCommittedEvent extends TurnEventBase {
  readonly type: 'input_committed';
  readonly entryId: string;
  readonly sessionLeafId: string;
}

/** The assistant message has been committed to Session and has a durable leaf. */
export interface AssistantMessageCompletedEvent extends TurnEventBase {
  readonly type: 'assistant_message_completed';
  readonly entryId: string;
  readonly sessionLeafId: string;
}

export interface ToolRequestedEvent extends TurnEventBase {
  readonly type: 'tool_requested';
  readonly callId: string;
  readonly name: string;
}

export interface ToolStartedEvent extends TurnEventBase {
  readonly type: 'tool_started';
  readonly callId: string;
  readonly name: string;
}

export interface ToolCompletedEvent extends TurnEventBase {
  readonly type: 'tool_completed';
  readonly callId: string;
  readonly name: string;
  readonly isError: boolean;
  readonly resultEntryId?: string;
  readonly sessionLeafId?: string | null;
}

export interface CompactionStartedEvent extends TurnEventBase {
  readonly type: 'compaction_started';
}

export interface CompactionCompletedEvent extends TurnEventBase {
  readonly type: 'compaction_completed';
  readonly entryId?: string;
  readonly sessionLeafId?: string | null;
}

export interface UsageRecordedEvent extends TurnEventBase {
  readonly type: 'usage_recorded';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface TurnResumedEvent extends TurnEventBase {
  readonly type: 'turn_resumed';
}

export interface TurnCompletedEvent extends TurnEventBase {
  readonly type: 'turn_completed';
  readonly resultLeafId: string | null;
}

export interface TurnFailedEvent extends TurnEventBase {
  readonly type: 'turn_failed';
  readonly message: string;
}

export interface TurnCancelledEvent extends TurnEventBase {
  readonly type: 'turn_cancelled';
}

/** Durable execution facts emitted by the Application Turn boundary. */
export type TurnEvent =
  | TurnStartedEvent
  | ModelStartedEvent
  | ModelCompletedEvent
  | InputCommittedEvent
  | AssistantMessageCompletedEvent
  | ToolRequestedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | CompactionStartedEvent
  | CompactionCompletedEvent
  | UsageRecordedEvent
  | TurnResumedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent;

/** The event names understood by the current durable event format. */
export type TurnEventType = TurnEvent['type'];

/** Validates common and discriminated TurnEvent fields. */
export function validateTurnEvent(event: unknown): asserts event is TurnEvent {
  if (!isRecord(event)) throw new TurnEventError('TurnEvent must be an object.');
  if (event.version !== CURRENT_TURN_EVENT_VERSION) {
    throw new TurnEventError(`Unsupported TurnEvent version: ${String(event.version)}.`);
  }
  if (!isNonEmptyString(event.id)) throw new TurnEventError('TurnEvent id must be non-empty.');
  if (!isNonEmptyString(event.turnId)) {
    throw new TurnEventError('TurnEvent turnId must be non-empty.');
  }
  if (!isNonEmptyString(event.sessionId)) {
    throw new TurnEventError('TurnEvent sessionId must be non-empty.');
  }
  if (!isNonNegativeInteger(event.sequence)) {
    throw new TurnEventError('TurnEvent sequence must be a non-negative integer.');
  }
  if (!isPositiveInteger(event.attempt)) {
    throw new TurnEventError('TurnEvent attempt must be a positive integer.');
  }
  if (!isTimestamp(event.timestamp)) throw new TurnEventError('TurnEvent timestamp is invalid.');

  switch (event.type) {
    case 'turn_started':
    case 'model_started':
    case 'model_completed':
    case 'compaction_started':
    case 'turn_resumed':
    case 'turn_cancelled':
      return;
    case 'input_committed':
      assertEntryId(event.entryId, 'input_committed entryId');
      assertEntryId(event.sessionLeafId, 'input_committed sessionLeafId');
      return;
    case 'assistant_message_completed':
      assertEntryId(event.entryId, 'assistant_message_completed entryId');
      assertEntryId(event.sessionLeafId, 'assistant_message_completed sessionLeafId');
      return;
    case 'tool_requested':
    case 'tool_started':
      assertCallId(event.callId);
      assertName(event.name);
      return;
    case 'tool_completed':
      assertCallId(event.callId);
      assertName(event.name);
      if (typeof event.isError !== 'boolean') {
        throw new TurnEventError('tool_completed isError must be boolean.');
      }
      if (event.resultEntryId !== undefined) {
        assertEntryId(event.resultEntryId, 'tool_completed resultEntryId');
      }
      if (event.sessionLeafId !== undefined) {
        assertNullableId(event.sessionLeafId, 'tool_completed sessionLeafId');
      }
      return;
    case 'compaction_completed':
      if (event.entryId !== undefined) assertEntryId(event.entryId, 'compaction_completed entryId');
      if (event.sessionLeafId !== undefined) {
        assertNullableId(event.sessionLeafId, 'compaction_completed sessionLeafId');
      }
      return;
    case 'usage_recorded':
      assertNonNegativeInteger(event.inputTokens, 'inputTokens');
      assertNonNegativeInteger(event.outputTokens, 'outputTokens');
      assertNonNegativeInteger(event.totalTokens, 'totalTokens');
      return;
    case 'turn_completed':
      assertNullableId(event.resultLeafId, 'turn_completed resultLeafId');
      return;
    case 'turn_failed':
      if (!isNonEmptyString(event.message)) {
        throw new TurnEventError('turn_failed message must be non-empty.');
      }
      return;
    default:
      throw new TurnEventError(`Unsupported TurnEvent type: ${String(event.type)}.`);
  }
}

/** Type guard used by persistence adapters before accepting unknown JSON. */
export function isTurnEvent(value: unknown): value is TurnEvent {
  try {
    validateTurnEvent(value);
    return true;
  } catch {
    return false;
  }
}

function assertCallId(value: unknown): asserts value is string {
  if (!isNonEmptyString(value)) throw new TurnEventError('TurnEvent callId must be non-empty.');
}

function assertName(value: unknown): asserts value is string {
  if (!isNonEmptyString(value)) throw new TurnEventError('TurnEvent tool name must be non-empty.');
}

function assertEntryId(value: unknown, field: string): asserts value is string {
  if (!isNonEmptyString(value)) throw new TurnEventError(`${field} must be non-empty.`);
}

function assertNullableId(value: unknown, field: string): void {
  if (value !== null) assertEntryId(value, field);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function assertNonNegativeInteger(value: unknown, field: string): void {
  if (!isNonNegativeInteger(value)) {
    throw new TurnEventError(`${field} must be a non-negative integer.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}
