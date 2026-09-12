import type { TurnStreamEvent } from './turn-stream-event.js';
import type { ToolDisplayInfo } from './tool-presentation.js';

export type TurnStreamProjectionStatus = 'running' | 'completed' | 'failed' | 'cancelled';
export type TurnStreamToolStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface TurnStreamToolProjection {
  readonly callId: string;
  readonly name: string;
  readonly display?: ToolDisplayInfo;
  readonly status: TurnStreamToolStatus;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** Transport-neutral, UI-safe state for the currently executing Turn. */
export interface TurnStreamProjection {
  readonly turnId: string;
  readonly sessionId: string;
  readonly status: TurnStreamProjectionStatus;
  readonly startedAt?: string;
  readonly assistant: {
    readonly text: string;
    readonly messageVisible: boolean;
    readonly isThinking: boolean;
  };
  readonly tools: readonly TurnStreamToolProjection[];
  readonly compaction: {
    readonly status: 'idle' | 'running';
  };
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  } | null;
  readonly lastSequence: number;
}

export interface TurnStreamProjectionIdentity {
  readonly turnId: string;
  readonly sessionId: string;
}

/** Creates the deterministic empty projection for a newly opened Turn channel. */
export function createInitialTurnStreamProjection(
  identity: TurnStreamProjectionIdentity,
): TurnStreamProjection;
export function createInitialTurnStreamProjection(
  turnId: string,
  sessionId: string,
): TurnStreamProjection;
export function createInitialTurnStreamProjection(
  identityOrTurnId: TurnStreamProjectionIdentity | string,
  sessionId?: string,
): TurnStreamProjection {
  const identity =
    typeof identityOrTurnId === 'string'
      ? { turnId: identityOrTurnId, sessionId: sessionId ?? '' }
      : identityOrTurnId;
  return {
    turnId: identity.turnId,
    sessionId: identity.sessionId,
    status: 'running',
    assistant: {
      text: '',
      messageVisible: false,
      isThinking: false,
    },
    tools: [],
    compaction: { status: 'idle' },
    usage: null,
    lastSequence: -1,
  };
}

/**
 * Applies one live event without performing IO or consulting mutable application state.
 * The function returns a fresh projection and is safe to replay from the Hub buffer.
 */
export function applyTurnStreamEvent(
  projection: TurnStreamProjection,
  event: TurnStreamEvent,
): TurnStreamProjection {
  const next: TurnStreamProjection = {
    ...projection,
    lastSequence: event.sequence,
  };

  switch (event.type) {
    case 'turn_started':
      return { ...next, status: 'running', startedAt: next.startedAt ?? event.timestamp };
    case 'assistant_thinking_started':
      return {
        ...next,
        assistant: { ...next.assistant, isThinking: true },
      };
    case 'assistant_thinking_completed':
      return {
        ...next,
        assistant: { ...next.assistant, isThinking: false },
      };
    case 'assistant_message_started':
      return {
        ...next,
        assistant: {
          text: '',
          messageVisible: true,
          isThinking: false,
        },
      };
    case 'assistant_text_delta':
      return {
        ...next,
        assistant: {
          ...next.assistant,
          text: next.assistant.text + event.delta,
          messageVisible: true,
          isThinking: false,
        },
      };
    case 'assistant_message_completed':
      return {
        ...next,
        assistant: {
          text: '',
          messageVisible: false,
          isThinking: false,
        },
      };
    case 'tool_queued':
      return {
        ...next,
        tools: upsertTool(next.tools, {
          callId: event.callId,
          name: event.name,
          display: event.display,
          status: 'queued',
        }),
      };
    case 'tool_started':
      return {
        ...next,
        tools: upsertTool(next.tools, {
          callId: event.callId,
          name: event.name,
          display: event.display,
          status: 'running',
          startedAt: event.timestamp,
        }),
      };
    case 'tool_completed':
      return {
        ...next,
        tools: upsertTool(next.tools, {
          callId: event.callId,
          name: event.name,
          display: event.display,
          status: event.isError ? 'failed' : 'completed',
          completedAt: event.timestamp,
        }),
      };
    case 'compaction_started':
      return { ...next, compaction: { status: 'running' } };
    case 'compaction_completed':
      return { ...next, compaction: { status: 'idle' } };
    case 'usage':
      return {
        ...next,
        usage: aggregateUsage(next.usage, event),
      };
    case 'turn_completed':
      return { ...next, status: 'completed', assistant: { ...next.assistant, isThinking: false } };
    case 'turn_failed':
      return { ...next, status: 'failed', assistant: { ...next.assistant, isThinking: false } };
    case 'turn_cancelled':
      return { ...next, status: 'cancelled', assistant: { ...next.assistant, isThinking: false } };
  }
}

function upsertTool(
  tools: readonly TurnStreamToolProjection[],
  replacement: TurnStreamToolProjection,
): readonly TurnStreamToolProjection[] {
  const index = tools.findIndex((tool) => tool.callId === replacement.callId);
  if (index < 0) return [...tools, replacement];
  const existing = tools[index]!;
  const display = replacement.display ?? existing.display;
  const startedAt = existing.startedAt ?? replacement.startedAt;
  const completedAt = existing.completedAt ?? replacement.completedAt;
  const next = {
    ...replacement,
    ...(display === undefined ? {} : { display }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
  return tools.map((tool, toolIndex) => (toolIndex === index ? next : tool));
}

/** Sums final usage contributions, with one contribution expected per model call. */
function aggregateUsage(
  current: TurnStreamProjection['usage'],
  event: Extract<TurnStreamEvent, { type: 'usage' }>,
): NonNullable<TurnStreamProjection['usage']> {
  return {
    inputTokens: (current?.inputTokens ?? 0) + event.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + event.outputTokens,
    totalTokens: (current?.totalTokens ?? 0) + event.totalTokens,
  };
}
