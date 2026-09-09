import type { AgentSessionEvent } from '../agent-session/agent-session.js';
import type { TurnStreamEventDraft, TurnStreamEventDraftPayload } from './turn-stream-event.js';

export interface TurnStreamProjectorIdentity {
  readonly turnId: string;
  readonly sessionId: string;
}

/**
 * Converts application Session execution events into UI-safe live event drafts.
 * Reasoning deltas are intentionally reduced to lifecycle markers and never emitted.
 */
export class TurnStreamProjector {
  private readonly turnId: string;
  private readonly sessionId: string;
  private thinkingActive = false;
  private assistantMessageVisible = false;
  private assistantText = '';
  private readonly queuedToolCalls = new Set<string>();

  public constructor(identity: TurnStreamProjectorIdentity) {
    this.turnId = identity.turnId;
    this.sessionId = identity.sessionId;
  }

  /** Projects one source event into zero or more transport-neutral live drafts. */
  public project(event: AgentSessionEvent): readonly TurnStreamEventDraft[] {
    switch (event.type) {
      case 'message_update':
        return this.projectMessageUpdate(event);
      case 'message_end':
        return this.projectMessageEnd(event.message);
      case 'tool_execution_start':
        return [
          this.draft({
            type: 'tool_started',
            callId: event.toolCall.callId,
            name: event.toolCall.name,
          }),
        ];
      case 'tool_execution_end':
        return [
          this.draft({
            type: 'tool_completed',
            callId: event.toolCall.callId,
            name: event.toolCall.name,
            isError: event.result.isError,
          }),
        ];
      case 'compaction_start':
        return [this.draft({ type: 'compaction_started', reason: event.reason })];
      case 'compaction_end':
        return [
          this.draft({
            type: 'compaction_completed',
            reason: event.reason,
            aborted: event.aborted,
            failed: event.errorMessage !== undefined,
            willRetry: event.willRetry,
          }),
        ];
      default:
        return [];
    }
  }

  private projectMessageUpdate(
    event: Extract<AgentSessionEvent, { type: 'message_update' }>,
  ): readonly TurnStreamEventDraft[] {
    switch (event.event.type) {
      case 'thinking.delta':
        if (this.thinkingActive) return [];
        this.thinkingActive = true;
        return [this.draft({ type: 'assistant_thinking_started' })];
      case 'text.delta': {
        const events: TurnStreamEventDraft[] = [];
        if (this.thinkingActive) {
          this.thinkingActive = false;
          events.push(this.draft({ type: 'assistant_thinking_completed' }));
        }
        if (!this.assistantMessageVisible) {
          this.assistantMessageVisible = true;
          events.push(this.draft({ type: 'assistant_message_started' }));
        }
        this.assistantText += event.event.delta;
        events.push(this.draft({ type: 'assistant_text_delta', delta: event.event.delta }));
        return events;
      }
      case 'tool-call.completed':
        return this.projectToolQueued(event.event.toolCall);
      case 'usage':
        return [
          this.draft({
            type: 'usage',
            inputTokens: event.event.usage.inputTokens,
            outputTokens: event.event.usage.outputTokens,
            totalTokens: event.event.usage.totalTokens,
          }),
        ];
      default:
        return [];
    }
  }

  private projectMessageEnd(
    message: Extract<AgentSessionEvent, { type: 'message_end' }>['message'],
  ): readonly TurnStreamEventDraft[] {
    if (message.role !== 'assistant') return [];
    const events: TurnStreamEventDraft[] = [];
    if (this.thinkingActive) {
      this.thinkingActive = false;
      events.push(this.draft({ type: 'assistant_thinking_completed' }));
    }
    const visibleText = message.content
      .flatMap((content) => (content.type === 'text' ? [content.text] : []))
      .join('');
    const missingText = visibleText.startsWith(this.assistantText)
      ? visibleText.slice(this.assistantText.length)
      : '';
    if (missingText.length > 0) {
      if (!this.assistantMessageVisible) {
        this.assistantMessageVisible = true;
        events.push(this.draft({ type: 'assistant_message_started' }));
      }
      events.push(this.draft({ type: 'assistant_text_delta', delta: missingText }));
    }
    if (this.assistantMessageVisible) {
      events.push(this.draft({ type: 'assistant_message_completed' }));
    }
    this.assistantMessageVisible = false;
    this.assistantText = '';
    for (const toolCall of message.toolCalls ?? []) {
      events.push(...this.projectToolQueued(toolCall));
    }
    return events;
  }

  private projectToolQueued(toolCall: {
    readonly callId: string;
    readonly name: string;
  }): readonly TurnStreamEventDraft[] {
    if (this.queuedToolCalls.has(toolCall.callId)) return [];
    this.queuedToolCalls.add(toolCall.callId);
    return [this.draft({ type: 'tool_queued', callId: toolCall.callId, name: toolCall.name })];
  }

  private draft(event: TurnStreamEventDraftPayload): TurnStreamEventDraft {
    return { ...event, turnId: this.turnId, sessionId: this.sessionId } as TurnStreamEventDraft;
  }
}
