import type { ModelToolCall } from '@opspilot/model-gateway';
import type { Session, SessionEntry, Turn, TurnEvent } from '@opspilot/domain';

import {
  resolveToolPresentation,
  type ToolPresentationResolver,
} from '../turn-stream/tool-presentation.js';
import {
  type TurnPresentationSummary,
  type TurnPresentationUsage,
  type TurnToolPresentationSummary,
} from './turn-presentation-summary.js';

export interface BuildTurnPresentationSummaryOptions {
  readonly turn: Turn;
  readonly events: readonly TurnEvent[];
  readonly session: Session;
  readonly toolPresentationResolver?: ToolPresentationResolver;
}

/** Builds a deterministic historical Turn presentation from durable facts only. */
export function buildTurnPresentationSummary(
  options: BuildTurnPresentationSummaryOptions,
): TurnPresentationSummary | undefined {
  const state = options.turn.getState();
  if (!isTerminalStatus(state.status) || state.inputEntryId === null) return undefined;
  if (state.startedAt === null || state.completedAt === null) return undefined;

  const events = [...options.events].sort((left, right) => left.sequence - right.sequence);
  const toolCalls = collectAssistantToolCalls(events, options.session);
  const tools = collectToolSummaries(events, toolCalls, options.toolPresentationResolver);
  const usage = collectUsage(events);

  return {
    turnId: state.id,
    sessionId: state.sessionId,
    inputEntryId: state.inputEntryId,
    status: state.status,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    usage,
    tools,
  };
}

function collectAssistantToolCalls(
  events: readonly TurnEvent[],
  session: Session,
): Map<string, ModelToolCall> {
  const toolCalls = new Map<string, ModelToolCall>();
  for (const event of events) {
    if (event.type !== 'assistant_message_completed') continue;
    const entry = session.getEntry(event.entryId);
    if (!isAssistantMessageEntry(entry)) continue;
    for (const toolCall of entry.message.toolCalls ?? []) {
      if (!toolCalls.has(toolCall.callId)) toolCalls.set(toolCall.callId, toolCall);
    }
  }
  return toolCalls;
}

function collectToolSummaries(
  events: readonly TurnEvent[],
  toolCalls: ReadonlyMap<string, ModelToolCall>,
  resolver: ToolPresentationResolver | undefined,
): readonly TurnToolPresentationSummary[] {
  const tools = new Map<string, MutableToolSummary>();

  for (const event of events) {
    switch (event.type) {
      case 'tool_requested': {
        const tool = getOrCreateTool(tools, event.callId, event.name);
        tool.name = tool.name || event.name;
        break;
      }
      case 'tool_started': {
        const tool = getOrCreateTool(tools, event.callId, event.name);
        tool.name = tool.name || event.name;
        tool.startedAt ??= event.timestamp;
        break;
      }
      case 'tool_completed': {
        const tool = getOrCreateTool(tools, event.callId, event.name);
        tool.name = tool.name || event.name;
        tool.status = event.isError ? 'failed' : 'completed';
        tool.completedAt = event.timestamp;
        break;
      }
      default:
        break;
    }
  }

  return [...tools.values()]
    .filter(
      (
        tool,
      ): tool is MutableToolSummary & { status: 'completed' | 'failed'; completedAt: string } =>
        tool.status !== undefined && tool.completedAt !== undefined,
    )
    .map((tool) => {
      const toolCall = toolCalls.get(tool.callId);
      const display = resolveToolPresentation({
        resolver,
        name: tool.name,
        arguments: toolCall?.arguments ?? {},
      });
      return {
        callId: tool.callId,
        name: tool.name,
        status: tool.status,
        display,
        ...(tool.startedAt === undefined ? {} : { startedAt: tool.startedAt }),
        completedAt: tool.completedAt,
      };
    });
}

function collectUsage(events: readonly TurnEvent[]): TurnPresentationUsage | null {
  const usageEvents = events.filter(
    (event): event is Extract<TurnEvent, { type: 'usage_recorded' }> =>
      event.type === 'usage_recorded',
  );
  if (usageEvents.length === 0) return null;
  return usageEvents.reduce<TurnPresentationUsage>(
    (total, event) => ({
      inputTokens: total.inputTokens + event.inputTokens,
      outputTokens: total.outputTokens + event.outputTokens,
      totalTokens: total.totalTokens + event.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function getOrCreateTool(
  tools: Map<string, MutableToolSummary>,
  callId: string,
  name: string,
): MutableToolSummary {
  const existing = tools.get(callId);
  if (existing !== undefined) return existing;
  const created: MutableToolSummary = { callId, name, status: undefined, completedAt: undefined };
  tools.set(callId, created);
  return created;
}

function isAssistantMessageEntry(entry: SessionEntry | undefined): entry is Extract<
  SessionEntry,
  { type: 'message' }
> & {
  readonly message: Extract<SessionEntry, { type: 'message' }>['message'] & { role: 'assistant' };
} {
  return entry?.type === 'message' && entry.message.role === 'assistant';
}

function isTerminalStatus(
  status: ReturnType<Turn['getState']>['status'],
): status is 'completed' | 'failed' | 'cancelled' {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

interface MutableToolSummary {
  readonly callId: string;
  name: string;
  status: 'completed' | 'failed' | undefined;
  startedAt?: string;
  completedAt: string | undefined;
}
