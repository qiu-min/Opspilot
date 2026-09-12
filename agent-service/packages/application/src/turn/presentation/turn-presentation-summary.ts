import type { ToolDisplayInfo } from './tool-presentation.js';

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
