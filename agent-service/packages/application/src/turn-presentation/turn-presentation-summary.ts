import type { JsonObject } from '@opspilot/model-gateway';
import type {
  ToolPresentationResolver,
  ToolDisplayInfo,
} from '../turn-stream/tool-presentation.js';

/** Aggregated final usage for one historical Turn. */
export interface TurnPresentationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/** UI-safe presentation data for one historical tool execution. */
export interface TurnToolPresentationSummary {
  readonly callId: string;
  readonly name: string;
  readonly status: 'completed' | 'failed';
  readonly display?: ToolDisplayInfo;
  readonly startedAt?: string;
  readonly completedAt?: string;
}

/** Durable read model used to restore completed Turn presentation. */
export interface TurnPresentationSummary {
  readonly turnId: string;
  readonly sessionId: string;
  readonly inputEntryId: string;
  readonly status: 'completed' | 'failed' | 'cancelled';
  readonly startedAt: string;
  readonly completedAt: string;
  readonly usage: TurnPresentationUsage | null;
  readonly tools: readonly TurnToolPresentationSummary[];
}

export interface ResolveHistoricalToolPresentationOptions {
  readonly resolver?: ToolPresentationResolver;
  readonly name: string;
  readonly arguments: JsonObject;
}

/** Resolves UI-safe tool metadata and always degrades to the tool name. */
export function resolveHistoricalToolPresentation(
  options: ResolveHistoricalToolPresentationOptions,
): ToolDisplayInfo {
  let resolved: unknown;
  try {
    resolved = options.resolver?.({
      name: options.name,
      arguments: options.arguments,
    });
  } catch {
    resolved = undefined;
  }

  return normalizeToolDisplayInfo(resolved) ?? { title: options.name };
}

function normalizeToolDisplayInfo(value: unknown): ToolDisplayInfo | undefined {
  if (!isRecord(value) || typeof value.title !== 'string' || value.title.trim().length === 0) {
    return undefined;
  }
  if (value.subject !== undefined && typeof value.subject !== 'string') return undefined;
  if (value.detail !== undefined && typeof value.detail !== 'string') return undefined;
  return {
    title: value.title,
    ...(value.subject === undefined ? {} : { subject: value.subject }),
    ...(value.detail === undefined ? {} : { detail: value.detail }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
