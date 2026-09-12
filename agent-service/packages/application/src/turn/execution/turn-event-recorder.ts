import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@opspilot/agent-runtime';
import type { ToolResultMessage } from '@opspilot/model-gateway';
import type { Session, SessionEntry, Turn, TurnEvent, TurnEventBase } from '@opspilot/domain';

import type { AgentSessionEvent } from '../../session/runtime/agent-session.js';
import type { TurnStore } from '../ports/turn-store.js';

/** Records low-frequency durable execution facts for one Application Turn. */
export class TurnEventRecorder {
  private readonly turn: Turn;
  private readonly session: Session;
  private readonly turnStore: TurnStore;
  private nextSequence: number;

  public constructor(turn: Turn, turnStore: TurnStore, session: Session) {
    this.turn = turn;
    this.session = session;
    this.turnStore = turnStore;
    this.nextSequence = turnStore.loadEvents(turn.getId()).length;
  }

  /** Records the first durable fact of a started Turn. */
  public recordTurnStarted(): void {
    this.append({ type: 'turn_started' });
  }

  /** Records the start of a new attempt on the existing Turn identity. */
  public recordTurnResumed(): void {
    this.append({ type: 'turn_resumed' });
  }

  /** Commits the user input checkpoint after Session append has succeeded. */
  public recordInputCommitted(entryId: string, sessionLeafId: string): void {
    this.turn.recordInput(entryId);
    this.turn.recordResultLeaf(sessionLeafId);
    const event = this.append({
      type: 'input_committed',
      entryId,
      sessionLeafId,
    });
    this.advanceCheckpoint(event, sessionLeafId, 'input_committed');
  }

  /** Records a model call start fact. */
  public recordModelStarted(): void {
    this.append({ type: 'model_started' });
  }

  /** Records a completed model response before recording its durable message commit. */
  public recordModelCompleted(): void {
    this.append({ type: 'model_completed' });
  }

  /** Records a durable assistant message and advances the assistant checkpoint. */
  public recordAssistantMessageCompleted(message: AgentMessage): void {
    const entry = this.requireCurrentMessageEntry(message, 'assistant');
    const event = this.append({
      type: 'assistant_message_completed',
      entryId: entry.id,
      sessionLeafId: entry.id,
    });
    this.turn.recordResultLeaf(entry.id);
    this.advanceCheckpoint(event, entry.id, 'assistant_committed');
  }

  /** Records one complete tool call after its ToolResult SessionEntry is durable. */
  public recordToolCompleted(message: AgentMessage): void {
    if (message.role !== 'tool') throw new Error('tool_completed requires a ToolResult message.');
    const entry = this.requireCurrentMessageEntry(message, 'tool');
    const event = this.append({
      type: 'tool_completed',
      callId: message.callId,
      name: message.name,
      isError: message.isError,
      resultEntryId: entry.id,
      sessionLeafId: entry.id,
    });
    this.turn.recordResultLeaf(entry.id);
    this.advanceCheckpoint(event, entry.id, 'tool_completed');
  }

  /** Records the point at which Runtime begins executing one tool. */
  public recordToolStarted(callId: string, name: string): void {
    this.append({ type: 'tool_started', callId, name });
  }

  /** Records a complete assistant tool-call batch after the assistant message is durable. */
  public recordToolRequested(callId: string, name: string): void {
    this.append({ type: 'tool_requested', callId, name });
  }

  /** Records one model call's final usage contribution when stable token counts are available. */
  public recordUsage(inputTokens: number, outputTokens: number, totalTokens: number): void {
    this.append({ type: 'usage_recorded', inputTokens, outputTokens, totalTokens });
  }

  /** Records the start of a compaction operation. */
  public recordCompactionStarted(): void {
    this.append({ type: 'compaction_started' });
  }

  /** Records a successfully durable CompactionEntry. */
  public recordCompactionCompleted(): void {
    const entry = this.session.getEntry(this.session.getLeafId() ?? '');
    if (entry?.type !== 'compaction') {
      throw new Error(
        'compaction_completed requires a durable CompactionEntry at the Session leaf.',
      );
    }
    this.append({
      type: 'compaction_completed',
      entryId: entry.id,
      sessionLeafId: entry.id,
    });
  }

  /** Records and persists a successful terminal Turn state. */
  public recordTurnCompleted(resultLeafId: string | null): void {
    this.append({ type: 'turn_completed', resultLeafId });
    this.turn.complete(resultLeafId);
    this.turnStore.save(this.turn);
  }

  /** Records and persists a failed terminal Turn state. */
  public recordTurnFailed(message: string): void {
    this.append({ type: 'turn_failed', message });
    this.turn.fail();
    this.turnStore.save(this.turn);
  }

  /** Records and persists a cancelled terminal Turn state. */
  public recordTurnCancelled(): void {
    this.append({ type: 'turn_cancelled' });
    this.turn.cancel();
    this.turnStore.save(this.turn);
  }

  /** Maps only durable AgentSession facts; streaming deltas remain observer-only. */
  public recordAgentSessionEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'step_start':
        this.recordModelStarted();
        return;
      case 'message_end':
        this.recordMessageCompleted(event.message);
        return;
      case 'tool_execution_start':
        this.recordToolStarted(event.toolCall.callId, event.toolCall.name);
        return;
      case 'compaction_start':
        this.recordCompactionStarted();
        return;
      case 'compaction_end':
        if (!event.aborted && event.result !== undefined) this.recordCompactionCompleted();
        return;
      default:
        return;
    }
  }

  private recordMessageCompleted(message: AgentMessage): void {
    if (message.role === 'assistant') {
      if (message.finishReason === 'error' || message.finishReason === 'aborted') return;
      this.recordModelCompleted();
      if (message.usage !== undefined) {
        this.recordUsage(
          message.usage.inputTokens,
          message.usage.outputTokens,
          message.usage.totalTokens,
        );
      }
      this.recordAssistantMessageCompleted(message);
      for (const toolCall of message.toolCalls ?? []) {
        this.recordToolRequested(toolCall.callId, toolCall.name);
      }
      return;
    }

    if (message.role === 'tool') this.recordToolCompleted(message as ToolResultMessage);
  }

  private append(payload: TurnEventPayload): TurnEvent {
    const state = this.turn.getState();
    const event = {
      version: 1 as const,
      id: randomUUID(),
      turnId: state.id,
      sessionId: state.sessionId,
      sequence: this.nextSequence,
      attempt: state.attempt,
      timestamp: new Date().toISOString(),
      ...payload,
    } as TurnEvent;
    this.turnStore.appendEvent(state.id, event);
    this.nextSequence += 1;
    return event;
  }

  private advanceCheckpoint(
    event: TurnEvent,
    sessionLeafId: string,
    phase: 'input_committed' | 'assistant_committed' | 'tool_completed',
  ): void {
    this.turn.advanceCheckpoint({
      eventSequence: event.sequence,
      sessionLeafId,
      phase,
    });
    this.turnStore.save(this.turn);
  }

  private requireCurrentMessageEntry(
    message: AgentMessage,
    role: 'assistant' | 'tool',
  ): Extract<SessionEntry, { type: 'message' }> {
    const leafId = this.session.getLeafId();
    const entry = leafId === null ? undefined : this.session.getEntry(leafId);
    if (entry?.type !== 'message' || entry.message.role !== role) {
      throw new Error(`Expected a durable ${role} SessionEntry at the current Session leaf.`);
    }
    if (role === 'tool') {
      const toolMessage = message as ToolResultMessage;
      if (entry.message.role !== 'tool' || entry.message.callId !== toolMessage.callId) {
        throw new Error(`Durable ToolResult does not match call ${toolMessage.callId}.`);
      }
    }
    return entry;
  }
}

type TurnEventPayload = {
  [Type in TurnEvent['type']]: Omit<Extract<TurnEvent, { type: Type }>, keyof TurnEventBase>;
}[TurnEvent['type']];
