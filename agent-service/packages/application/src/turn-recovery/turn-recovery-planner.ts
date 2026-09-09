import type { AssistantMessage, ModelToolCall, ToolResultMessage } from '@opspilot/model-gateway';
import {
  type Session,
  type SessionEntry,
  type Turn,
  type TurnCheckpoint,
  type TurnEvent,
} from '@opspilot/domain';

import type { ToolDefinition } from '../tools/tool-definition.js';
import type { TurnRecoveryPlan } from './turn-recovery-plan.js';

export interface TurnRecoveryPlannerInput {
  readonly turn: Turn;
  readonly events: readonly TurnEvent[];
  readonly session: Session;
  readonly toolDefinitions?: readonly ToolDefinition[];
}

/** Purely analyzes durable Turn/Session facts into one safe recovery action. */
export class TurnRecoveryPlanner {
  public plan(input: TurnRecoveryPlannerInput): TurnRecoveryPlan {
    const terminalEvent = findTerminalEvent(input.events, input.turn.getState().attempt);
    if (terminalEvent !== undefined) {
      return { kind: 'reconcile_terminal', terminalEvent };
    }

    const checkpointResult = calculateEffectiveCheckpoint(input);
    if (checkpointResult.kind === 'invalid') {
      return { kind: 'unrecoverable', reason: checkpointResult.reason };
    }
    const effectiveCheckpoint = checkpointResult.checkpoint;
    const safeLeafId = effectiveCheckpoint.sessionLeafId;
    if (safeLeafId === null || input.session.getEntry(safeLeafId) === undefined) {
      return {
        kind: 'unrecoverable',
        reason: 'Checkpoint does not identify a durable Session entry.',
      };
    }

    if (effectiveCheckpoint.phase === 'input_committed') {
      return { kind: 'continue_model', sessionLeafId: safeLeafId, effectiveCheckpoint };
    }

    const assistant = findAssistantAtCheckpoint(input.session, effectiveCheckpoint);
    if (assistant === undefined) {
      return {
        kind: 'unrecoverable',
        reason: 'Assistant checkpoint does not identify a durable assistant message.',
      };
    }
    const toolCalls = assistant.message.toolCalls ?? [];
    if (
      effectiveCheckpoint.phase === 'assistant_committed' &&
      (assistant.message.finishReason !== 'tool_calls' || toolCalls.length === 0)
    ) {
      return {
        kind: 'complete_from_assistant',
        sessionLeafId: assistant.entry.id,
        effectiveCheckpoint,
      };
    }
    if (toolCalls.length === 0) {
      return {
        kind: 'unrecoverable',
        reason: 'A tool checkpoint has no corresponding assistant tool-call batch.',
      };
    }

    const branch = input.session.getBranch(safeLeafId);
    const assistantIndex = branch.findIndex((entry) => entry.id === assistant.entry.id);
    if (assistantIndex < 0) {
      return {
        kind: 'unrecoverable',
        reason: 'Assistant checkpoint is not on the recovery branch.',
      };
    }
    const results = branch.slice(assistantIndex + 1).filter(isToolResultEntry);
    const completedCallIds = new Set<string>();
    for (const result of results) {
      if (!toolCalls.some((call) => call.callId === result.message.callId)) {
        return {
          kind: 'unrecoverable',
          reason: `Session contains a ToolResult for unknown call ${result.message.callId}.`,
        };
      }
      if (!completedCallIds.add(result.message.callId)) {
        return {
          kind: 'unrecoverable',
          reason: `Session contains duplicate ToolResult call ${result.message.callId}.`,
        };
      }
    }

    const pendingToolCalls = toolCalls.filter((call) => !completedCallIds.has(call.callId));
    const nonRecoverableError = results.find(
      (result) => result.message.isError && !isRecoverableToolError(result.message.details),
    );
    if (nonRecoverableError !== undefined) {
      return {
        kind: 'blocked',
        reason: 'A previous tool attempt ended with a non-recoverable tool error.',
        callIds: [nonRecoverableError.message.callId],
        effectiveCheckpoint,
      };
    }
    if (pendingToolCalls.length === 0) {
      return { kind: 'continue_model', sessionLeafId: safeLeafId, effectiveCheckpoint };
    }

    const assistantEventSequence = findAssistantEventSequence(input.events, assistant.entry.id);
    const ambiguousCallIds = pendingToolCalls
      .filter(
        (call) =>
          assistantEventSequence !== undefined &&
          hasUncompletedToolStarted(input.events, call, assistantEventSequence),
      )
      .filter((call) => {
        const definition = input.toolDefinitions?.find((candidate) => candidate.name === call.name);
        return definition?.recoveryPolicy !== 'retry_safe';
      })
      .map((call) => call.callId);
    if (ambiguousCallIds.length > 0) {
      return {
        kind: 'blocked',
        reason: 'A tool was durably started but has no durable completion and is not retry-safe.',
        callIds: ambiguousCallIds,
        effectiveCheckpoint,
      };
    }

    const missingDefinition = pendingToolCalls.find(
      (call) => input.toolDefinitions?.every((definition) => definition.name !== call.name) ?? true,
    );
    if (missingDefinition !== undefined) {
      return {
        kind: 'blocked',
        reason: `No ToolDefinition is available for ${missingDefinition.name}.`,
        callIds: [missingDefinition.callId],
        effectiveCheckpoint,
      };
    }

    return {
      kind: 'resume_tools',
      sessionLeafId: safeLeafId,
      assistantEntryId: assistant.entry.id,
      assistantMessage: assistant.message,
      pendingToolCalls,
      effectiveCheckpoint,
    };
  }
}

interface CheckpointCalculation {
  readonly kind: 'valid';
  readonly checkpoint: TurnCheckpoint;
}

interface InvalidCheckpointCalculation {
  readonly kind: 'invalid';
  readonly reason: string;
}

function calculateEffectiveCheckpoint(
  input: TurnRecoveryPlannerInput,
): CheckpointCalculation | InvalidCheckpointCalculation {
  let checkpoint = input.turn.getState().checkpoint;
  const snapshotSequence = checkpoint?.eventSequence ?? -1;

  if (checkpoint !== null && checkpoint !== undefined) {
    const validation = validateCheckpointEvidence(checkpoint, input.events, input.session);
    if (validation !== undefined) return { kind: 'invalid', reason: validation };
  }

  for (const event of input.events) {
    if (event.sequence <= snapshotSequence) continue;
    const safe = safeCheckpointFromEvent(event);
    if (safe === undefined) continue;
    const validation = validateCheckpointEvidence(safe, input.events, input.session);
    if (validation !== undefined) return { kind: 'invalid', reason: validation };
    checkpoint = safe;
  }

  if (checkpoint === null || checkpoint === undefined) {
    return { kind: 'invalid', reason: 'No durable input checkpoint exists for this Turn.' };
  }
  const effectiveCheckpoint = checkpoint;
  if (
    !input.events.some(
      (event) =>
        event.type === 'input_committed' && event.sequence <= effectiveCheckpoint.eventSequence,
    )
  ) {
    return { kind: 'invalid', reason: 'No durable input checkpoint exists for this Turn.' };
  }
  if (checkpoint.sessionLeafId === null) {
    return { kind: 'invalid', reason: 'The effective checkpoint has no durable Session leaf.' };
  }
  return { kind: 'valid', checkpoint };
}

function safeCheckpointFromEvent(event: TurnEvent): TurnCheckpoint | undefined {
  switch (event.type) {
    case 'input_committed':
      return {
        eventSequence: event.sequence,
        sessionLeafId: event.sessionLeafId,
        phase: 'input_committed',
      };
    case 'assistant_message_completed':
      return {
        eventSequence: event.sequence,
        sessionLeafId: event.sessionLeafId,
        phase: 'assistant_committed',
      };
    case 'tool_completed':
      return {
        eventSequence: event.sequence,
        sessionLeafId: event.sessionLeafId,
        phase: 'tool_completed',
      };
    default:
      return undefined;
  }
}

function validateCheckpointEvidence(
  checkpoint: TurnCheckpoint,
  events: readonly TurnEvent[],
  session: Session,
): string | undefined {
  const event = events[checkpoint.eventSequence];
  if (event === undefined) return 'Checkpoint does not reference an existing durable event.';
  const expectedType =
    checkpoint.phase === 'input_committed'
      ? 'input_committed'
      : checkpoint.phase === 'assistant_committed'
        ? 'assistant_message_completed'
        : 'tool_completed';
  if (event.type !== expectedType) return `Checkpoint phase does not match event ${event.type}.`;
  const sessionLeafId =
    event.type === 'input_committed' ||
    event.type === 'assistant_message_completed' ||
    event.type === 'tool_completed'
      ? event.sessionLeafId
      : undefined;
  if (sessionLeafId !== checkpoint.sessionLeafId)
    return 'Checkpoint Session leaf does not match its event.';
  if (session.getEntry(checkpoint.sessionLeafId ?? '') === undefined) {
    return 'Checkpoint references a missing durable Session entry.';
  }
  if (event.type === 'input_committed' && session.getEntry(event.entryId) === undefined) {
    return 'input_committed references a missing Session entry.';
  }
  if (event.type === 'input_committed') {
    const entry = session.getEntry(event.entryId);
    if (
      event.entryId !== event.sessionLeafId ||
      entry?.type !== 'message' ||
      entry.message.role !== 'user'
    ) {
      return 'input_committed does not identify the durable user input leaf.';
    }
  }
  if (event.type === 'assistant_message_completed' && event.entryId !== checkpoint.sessionLeafId) {
    return 'assistant_message_completed entry does not match its Session leaf.';
  }
  if (event.type === 'tool_completed' && event.resultEntryId !== checkpoint.sessionLeafId) {
    return 'tool_completed result entry does not match its Session leaf.';
  }
  if (event.type === 'assistant_message_completed') {
    const entry = session.getEntry(event.entryId);
    if (entry?.type !== 'message' || entry.message.role !== 'assistant') {
      return 'assistant_message_completed does not identify a durable assistant message.';
    }
  }
  if (event.type === 'tool_completed') {
    const entry = session.getEntry(event.resultEntryId);
    if (
      entry?.type !== 'message' ||
      entry.message.role !== 'tool' ||
      entry.message.callId !== event.callId
    ) {
      return 'tool_completed does not identify the durable ToolResult for its call.';
    }
  }
  return undefined;
}

function findAssistantAtCheckpoint(
  session: Session,
  checkpoint: TurnCheckpoint,
):
  | {
      readonly entry: Extract<SessionEntry, { type: 'message' }>;
      readonly message: AssistantMessage;
    }
  | undefined {
  const entry = session.getEntry(checkpoint.sessionLeafId ?? '');
  if (entry?.type === 'message' && entry.message.role === 'assistant') {
    return { entry, message: entry.message };
  }
  if (checkpoint.phase !== 'tool_completed') return undefined;
  const branch = session.getBranch(checkpoint.sessionLeafId ?? '');
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const candidate = branch[index];
    if (
      candidate?.type === 'message' &&
      candidate.message.role === 'assistant' &&
      candidate.message.finishReason === 'tool_calls' &&
      (candidate.message.toolCalls?.length ?? 0) > 0
    ) {
      return { entry: candidate, message: candidate.message };
    }
  }
  return undefined;
}

function hasUncompletedToolStarted(
  events: readonly TurnEvent[],
  call: ModelToolCall,
  afterSequence: number,
): boolean {
  let started = false;
  let completed = false;
  for (const event of events) {
    if (
      event.sequence <= afterSequence ||
      event.type === 'turn_completed' ||
      event.type === 'turn_failed' ||
      event.type === 'turn_cancelled'
    )
      continue;
    if (
      (event.type === 'tool_started' || event.type === 'tool_requested') &&
      event.callId === call.callId
    ) {
      if (event.type === 'tool_started') started = true;
    }
    if (event.type === 'tool_completed' && event.callId === call.callId) completed = true;
  }
  return started && !completed;
}

function findAssistantEventSequence(
  events: readonly TurnEvent[],
  entryId: string,
): number | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'assistant_message_completed' && event.entryId === entryId)
      return event.sequence;
  }
  return undefined;
}

function findTerminalEvent(
  events: readonly TurnEvent[],
  attempt: number,
): Extract<TurnEvent, { type: 'turn_completed' | 'turn_failed' | 'turn_cancelled' }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event?.attempt === attempt &&
      (event.type === 'turn_completed' ||
        event.type === 'turn_failed' ||
        event.type === 'turn_cancelled')
    )
      return event;
  }
  return undefined;
}

function isRecoverableToolError(details: unknown): boolean {
  return (
    typeof details === 'object' &&
    details !== null &&
    'kind' in details &&
    details.kind === 'recoverable'
  );
}

function isToolResultEntry(
  entry: SessionEntry,
): entry is Extract<SessionEntry, { type: 'message' }> & { readonly message: ToolResultMessage } {
  return entry.type === 'message' && entry.message.role === 'tool';
}
