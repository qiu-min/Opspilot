import type { TurnEvent } from '@opspilot/domain';

/** Kinds of logical spans that can be projected from durable TurnEvents. */
export type TraceSpanKind = 'model' | 'tool' | 'compaction';

/** Statuses that describe the facts available for one logical span. */
export type TraceSpanStatus = 'completed' | 'incomplete' | 'error';

/** Status of a Turn as determined by its durable lifecycle events. */
export type TurnTraceStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Common projection fields shared by all logical span kinds. */
export interface TraceSpanBase {
  readonly id: string;
  readonly kind: TraceSpanKind;
  readonly attempt: number;
  readonly status: TraceSpanStatus;
  /** The first execution lifecycle sequence; Tool spans use tool_requested only as a fallback. */
  readonly startSequence: number | null;
  readonly endSequence: number | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
}

/** Token usage attributed to one model call. */
export interface ModelTraceUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** Projection of model_started, model_completed, and usage_recorded events. */
export interface ModelTraceSpan extends TraceSpanBase {
  readonly kind: 'model';
  readonly modelCallId: string;
  readonly usage: ModelTraceUsage | null;
}

/** Projection of the lifecycle of one tool call. */
export interface ToolTraceSpan extends TraceSpanBase {
  readonly kind: 'tool';
  readonly callId: string;
  readonly name: string;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly isError: boolean;
}

/** Projection of one serial compaction lifecycle. */
export interface CompactionTraceSpan extends TraceSpanBase {
  readonly kind: 'compaction';
  readonly entryId?: string;
  readonly sessionLeafId?: string | null;
}

/** All logical span kinds emitted by the Turn trace projection. */
export type TraceSpan = ModelTraceSpan | ToolTraceSpan | CompactionTraceSpan;

/** Deterministic, in-memory read model rebuilt from durable TurnEvents. */
export interface TurnTrace {
  readonly turnId: string;
  readonly sessionId: string;
  readonly status: TurnTraceStatus;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly spans: readonly TraceSpan[];
}

interface OrderedEvent {
  readonly event: TurnEvent;
  readonly inputIndex: number;
}

interface ModelSpanState {
  readonly modelCallId: string;
  attempt: number;
  startSequence: number | null;
  startedAt: string | null;
  endSequence: number | null;
  endedAt: string | null;
  hasCompletion: boolean;
  usage: ModelTraceUsage | null;
}

interface ToolSpanState {
  readonly callId: string;
  attempt: number;
  name: string;
  requestedSequence: number | null;
  requestedAt: string | null;
  startedSequence: number | null;
  startedAt: string | null;
  endSequence: number | null;
  endedAt: string | null;
  hasCompletion: boolean;
  isError: boolean;
}

interface CompactionSpanState {
  readonly startSequence: number;
  readonly attempt: number;
  readonly startedAt: string;
  endSequence: number | null;
  endedAt: string | null;
  hasCompletion: boolean;
  entryId?: string;
  sessionLeafId?: string | null;
}

/**
 * Projects durable TurnEvents into a deterministic logical trace.
 *
 * The input is sorted by durable sequence before it is interpreted. Missing
 * terminal events remain incomplete spans so crash-recovered history can be
 * inspected without requiring a successful execution.
 */
export function projectTurnTrace(events: readonly TurnEvent[]): TurnTrace {
  const orderedEvents = orderEvents(events);
  const identity = orderedEvents[0]?.event;
  const modelSpans = new Map<string, ModelSpanState>();
  const toolSpans = new Map<string, ToolSpanState>();
  const compactionSpans: CompactionSpanState[] = [];
  let turnStarted: TurnEvent | undefined;
  let turnTerminal: TurnEvent | undefined;

  for (const { event } of orderedEvents) {
    switch (event.type) {
      case 'turn_started':
        if (turnStarted === undefined) turnStarted = event;
        break;
      case 'turn_completed':
      case 'turn_failed':
      case 'turn_cancelled':
        if (turnTerminal === undefined) turnTerminal = event;
        break;
      case 'model_started':
        projectModelStarted(modelSpans, event);
        break;
      case 'model_completed':
        projectModelCompleted(modelSpans, event);
        break;
      case 'usage_recorded':
        projectUsage(modelSpans, event);
        break;
      case 'tool_requested':
        projectToolRequested(toolSpans, event);
        break;
      case 'tool_started':
        projectToolStarted(toolSpans, event);
        break;
      case 'tool_completed':
        projectToolCompleted(toolSpans, event);
        break;
      case 'compaction_started':
        compactionSpans.push({
          startSequence: event.sequence,
          attempt: event.attempt,
          startedAt: event.timestamp,
          endSequence: null,
          endedAt: null,
          hasCompletion: false,
        });
        break;
      case 'compaction_completed':
        projectCompactionCompleted(compactionSpans, event);
        break;
      case 'input_committed':
      case 'assistant_message_completed':
      case 'turn_resumed':
        break;
    }
  }

  const spans = [
    ...[...modelSpans.values()].map(toModelTraceSpan),
    ...[...toolSpans.values()].map(toToolTraceSpan),
    ...compactionSpans.map(toCompactionTraceSpan),
  ].sort(compareSpanOrder);
  const endedAt = turnTerminal?.timestamp ?? null;

  return {
    turnId: identity?.turnId ?? '',
    sessionId: identity?.sessionId ?? '',
    status: getTurnStatus(turnTerminal),
    startedAt: turnStarted?.timestamp ?? null,
    endedAt,
    durationMs: calculateDuration(turnStarted?.timestamp ?? null, endedAt),
    spans,
  };
}

/** Orders durable events independently of the caller's array order. */
function orderEvents(events: readonly TurnEvent[]): OrderedEvent[] {
  return events
    .map((event, inputIndex) => ({ event, inputIndex }))
    .sort((left, right) => {
      const sequenceOrder = left.event.sequence - right.event.sequence;
      if (sequenceOrder !== 0) return sequenceOrder;
      const idOrder = compareStrings(left.event.id, right.event.id);
      return idOrder !== 0 ? idOrder : left.inputIndex - right.inputIndex;
    });
}

/** Creates or returns the model span state for one modelCallId. */
function getModelState(
  spans: Map<string, ModelSpanState>,
  modelCallId: string,
  attempt: number,
): ModelSpanState {
  const existing = spans.get(modelCallId);
  if (existing !== undefined) return existing;
  const created: ModelSpanState = {
    modelCallId,
    attempt,
    startSequence: null,
    startedAt: null,
    endSequence: null,
    endedAt: null,
    hasCompletion: false,
    usage: null,
  };
  spans.set(modelCallId, created);
  return created;
}

/** Projects the first durable start fact for a model call. */
function projectModelStarted(
  spans: Map<string, ModelSpanState>,
  event: Extract<TurnEvent, { type: 'model_started' }>,
): void {
  const state = getModelState(spans, event.modelCallId, event.attempt);
  if (state.startSequence !== null) return;
  state.attempt = event.attempt;
  state.startSequence = event.sequence;
  state.startedAt = event.timestamp;
}

/** Projects the first durable completion fact for a model call. */
function projectModelCompleted(
  spans: Map<string, ModelSpanState>,
  event: Extract<TurnEvent, { type: 'model_completed' }>,
): void {
  const state = getModelState(spans, event.modelCallId, event.attempt);
  if (state.hasCompletion) return;
  state.endSequence = event.sequence;
  state.endedAt = event.timestamp;
  state.hasCompletion = true;
}

/** Projects the first usage fact for a model call, regardless of event adjacency. */
function projectUsage(
  spans: Map<string, ModelSpanState>,
  event: Extract<TurnEvent, { type: 'usage_recorded' }>,
): void {
  const state = getModelState(spans, event.modelCallId, event.attempt);
  if (state.usage !== null) return;
  state.usage = {
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens,
  };
}

/** Creates or returns the tool span state for one callId. */
function getToolState(
  spans: Map<string, ToolSpanState>,
  callId: string,
  name: string,
  attempt: number,
): ToolSpanState {
  const key = getToolExecutionKey(callId, attempt);
  const existing = spans.get(key);
  if (existing !== undefined) return existing;
  const created: ToolSpanState = {
    callId,
    attempt,
    name,
    requestedSequence: null,
    requestedAt: null,
    startedSequence: null,
    startedAt: null,
    endSequence: null,
    endedAt: null,
    hasCompletion: false,
    isError: false,
  };
  spans.set(key, created);
  return created;
}

/** Projects the first tool request and preserves its queue timestamp. */
function projectToolRequested(
  spans: Map<string, ToolSpanState>,
  event: Extract<TurnEvent, { type: 'tool_requested' }>,
): void {
  const state = getToolState(spans, event.callId, event.name, event.attempt);
  if (state.requestedSequence !== null) return;
  state.requestedSequence = event.sequence;
  state.requestedAt = event.timestamp;
}

/** Projects the first actual tool execution start. */
function projectToolStarted(
  spans: Map<string, ToolSpanState>,
  event: Extract<TurnEvent, { type: 'tool_started' }>,
): void {
  const state = getToolState(spans, event.callId, event.name, event.attempt);
  if (state.startedSequence !== null) return;
  state.attempt = event.attempt;
  state.startedSequence = event.sequence;
  state.startedAt = event.timestamp;
}

/** Projects the first tool completion and its error flag. */
function projectToolCompleted(
  spans: Map<string, ToolSpanState>,
  event: Extract<TurnEvent, { type: 'tool_completed' }>,
): void {
  const state = getToolState(spans, event.callId, event.name, event.attempt);
  if (state.hasCompletion) return;
  state.endSequence = event.sequence;
  state.endedAt = event.timestamp;
  state.hasCompletion = true;
  state.isError = event.isError;
}

/** Pairs a compaction completion with the earliest open compaction. */
function projectCompactionCompleted(
  spans: CompactionSpanState[],
  event: Extract<TurnEvent, { type: 'compaction_completed' }>,
): void {
  const open = spans.find((span) => !span.hasCompletion && span.attempt === event.attempt);
  if (open === undefined) return;
  open.endSequence = event.sequence;
  open.endedAt = event.timestamp;
  open.hasCompletion = true;
  if (event.entryId !== undefined) open.entryId = event.entryId;
  if (event.sessionLeafId !== undefined) open.sessionLeafId = event.sessionLeafId;
}

/** Converts internal model state into the public immutable projection shape. */
function toModelTraceSpan(state: ModelSpanState): ModelTraceSpan {
  const completed =
    state.hasCompletion &&
    state.startSequence !== null &&
    state.endSequence !== null &&
    state.endSequence >= state.startSequence;
  return {
    id: `model:${state.modelCallId}`,
    kind: 'model',
    modelCallId: state.modelCallId,
    attempt: state.attempt,
    status: completed ? 'completed' : 'incomplete',
    startSequence: state.startSequence,
    endSequence: state.endSequence,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    durationMs: completed ? calculateDuration(state.startedAt, state.endedAt) : null,
    usage: state.usage,
  };
}

/** Converts internal tool state into the public immutable projection shape. */
function toToolTraceSpan(state: ToolSpanState): ToolTraceSpan {
  const executionCompleted =
    state.hasCompletion &&
    state.startedSequence !== null &&
    state.endSequence !== null &&
    state.endSequence >= state.startedSequence;
  return {
    id: `tool:${state.callId}:attempt:${state.attempt}`,
    kind: 'tool',
    callId: state.callId,
    name: state.name,
    attempt: state.attempt,
    status: state.isError ? 'error' : executionCompleted ? 'completed' : 'incomplete',
    startSequence: state.startedSequence ?? state.requestedSequence,
    endSequence: state.endSequence,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    durationMs: executionCompleted ? calculateDuration(state.startedAt, state.endedAt) : null,
    requestedAt: state.requestedAt,
    isError: state.isError,
  };
}

/** Keeps one Tool execution span per logical call and durable attempt. */
function getToolExecutionKey(callId: string, attempt: number): string {
  return `${callId}:${attempt}`;
}

/** Converts internal compaction state into the public immutable projection shape. */
function toCompactionTraceSpan(state: CompactionSpanState): CompactionTraceSpan {
  return {
    id: `compaction:${state.startSequence}`,
    kind: 'compaction',
    attempt: state.attempt,
    status: state.hasCompletion ? 'completed' : 'incomplete',
    startSequence: state.startSequence,
    endSequence: state.endSequence,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    durationMs: state.hasCompletion ? calculateDuration(state.startedAt, state.endedAt) : null,
    ...(state.entryId === undefined ? {} : { entryId: state.entryId }),
    ...(state.sessionLeafId === undefined ? {} : { sessionLeafId: state.sessionLeafId }),
  };
}

/** Maps the first terminal TurnEvent to the public Turn status. */
function getTurnStatus(event: TurnEvent | undefined): TurnTraceStatus {
  switch (event?.type) {
    case 'turn_completed':
      return 'completed';
    case 'turn_failed':
      return 'failed';
    case 'turn_cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
}

/** Orders spans by their first durable lifecycle sequence. */
function compareSpanOrder(left: TraceSpan, right: TraceSpan): number {
  const leftSequence = left.startSequence ?? left.endSequence ?? Number.MAX_SAFE_INTEGER;
  const rightSequence = right.startSequence ?? right.endSequence ?? Number.MAX_SAFE_INTEGER;
  if (leftSequence !== rightSequence) return leftSequence - rightSequence;
  return compareStrings(left.id, right.id);
}

/** Calculates a deterministic non-negative duration, or null for malformed bounds. */
function calculateDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (startedAt === null || endedAt === null) return null;
  const startedMs = Date.parse(startedAt);
  const endedMs = Date.parse(endedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedMs) || endedMs < startedMs) {
    return null;
  }
  return endedMs - startedMs;
}

/** Compares strings without relying on locale-specific collation. */
function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
