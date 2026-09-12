import type { ToolDisplayInfo } from './tool-presentation.js';

/** Common fields carried by every ephemeral UI stream event. */
export interface TurnStreamEventBase {
  readonly turnId: string;
  readonly sessionId: string;
  /** Sequence is assigned by TurnStreamHub and is contiguous for one Turn. */
  readonly sequence: number;
  readonly timestamp: string;
}

export interface TurnStartedStreamEvent extends TurnStreamEventBase {
  readonly type: 'turn_started';
}

export interface AssistantThinkingStartedStreamEvent extends TurnStreamEventBase {
  readonly type: 'assistant_thinking_started';
}

export interface AssistantThinkingCompletedStreamEvent extends TurnStreamEventBase {
  readonly type: 'assistant_thinking_completed';
}

export interface AssistantMessageStartedStreamEvent extends TurnStreamEventBase {
  readonly type: 'assistant_message_started';
}

export interface AssistantTextDeltaStreamEvent extends TurnStreamEventBase {
  readonly type: 'assistant_text_delta';
  readonly delta: string;
}

export interface AssistantMessageCompletedStreamEvent extends TurnStreamEventBase {
  readonly type: 'assistant_message_completed';
}

export interface ToolQueuedStreamEvent extends TurnStreamEventBase {
  readonly type: 'tool_queued';
  readonly callId: string;
  readonly name: string;
  readonly batchId?: string;
  readonly display?: ToolDisplayInfo;
}

export interface ToolStartedStreamEvent extends TurnStreamEventBase {
  readonly type: 'tool_started';
  readonly callId: string;
  readonly name: string;
  readonly display?: ToolDisplayInfo;
}

export interface ToolCompletedStreamEvent extends TurnStreamEventBase {
  readonly type: 'tool_completed';
  readonly callId: string;
  readonly name: string;
  readonly isError: boolean;
  readonly display?: ToolDisplayInfo;
}

export interface CompactionStartedStreamEvent extends TurnStreamEventBase {
  readonly type: 'compaction_started';
  readonly reason?: string;
}

export interface CompactionCompletedStreamEvent extends TurnStreamEventBase {
  readonly type: 'compaction_completed';
  readonly reason?: string;
  readonly aborted?: boolean;
  readonly failed?: boolean;
  readonly willRetry?: boolean;
}

/** Final token usage contribution for one completed model call. */
export interface UsageStreamEvent extends TurnStreamEventBase {
  readonly type: 'usage';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

export interface TurnCompletedStreamEvent extends TurnStreamEventBase {
  readonly type: 'turn_completed';
  readonly resultLeafId: string | null;
}

export interface TurnFailedStreamEvent extends TurnStreamEventBase {
  readonly type: 'turn_failed';
  readonly message: string;
}

export interface TurnCancelledStreamEvent extends TurnStreamEventBase {
  readonly type: 'turn_cancelled';
}

/** Presentation/live facts. This is deliberately independent from AgentEvent and TurnEvent. */
export type TurnStreamEvent =
  | TurnStartedStreamEvent
  | AssistantThinkingStartedStreamEvent
  | AssistantThinkingCompletedStreamEvent
  | AssistantMessageStartedStreamEvent
  | AssistantTextDeltaStreamEvent
  | AssistantMessageCompletedStreamEvent
  | ToolQueuedStreamEvent
  | ToolStartedStreamEvent
  | ToolCompletedStreamEvent
  | CompactionStartedStreamEvent
  | CompactionCompletedStreamEvent
  | UsageStreamEvent
  | TurnCompletedStreamEvent
  | TurnFailedStreamEvent
  | TurnCancelledStreamEvent;

/** Input accepted by the Hub. Sequence and timestamp remain Hub-owned fields. */
export type TurnStreamEventDraft = {
  [Type in TurnStreamEvent['type']]: Omit<
    Extract<TurnStreamEvent, { type: Type }>,
    'sequence' | 'timestamp'
  > & { readonly timestamp?: string };
}[TurnStreamEvent['type']];

/** Payload shape used by Projector before the Hub adds the channel envelope. */
export type TurnStreamEventDraftPayload = {
  [Type in TurnStreamEvent['type']]: Omit<
    Extract<TurnStreamEvent, { type: Type }>,
    'turnId' | 'sessionId' | 'sequence' | 'timestamp'
  >;
}[TurnStreamEvent['type']];

export type TurnStreamEventType = TurnStreamEvent['type'];

export function isTurnStreamTerminalEvent(
  event: TurnStreamEvent,
): event is TurnCompletedStreamEvent | TurnFailedStreamEvent | TurnCancelledStreamEvent {
  return (
    event.type === 'turn_completed' ||
    event.type === 'turn_failed' ||
    event.type === 'turn_cancelled'
  );
}
