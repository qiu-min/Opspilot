import type { TurnResponseMetrics, TurnResponseStatus, TurnUsage } from "./types";

/** Sums final per-model-call usage contributions from the current live Turn. */
export function aggregateTurnUsage(usageEvents: readonly TurnUsage[]): TurnUsage | null {
  if (usageEvents.length === 0) return null;
  return usageEvents.reduce<TurnUsage>((total, usage) => ({
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
}

export function getDurationMs(startedAt: string | undefined, completedAt: string | number | Date | undefined): number | undefined {
  if (startedAt === undefined || completedAt === undefined) return undefined;
  const start = Date.parse(startedAt);
  const end = completedAt instanceof Date ? completedAt.getTime() : typeof completedAt === "number" ? completedAt : Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

export function formatDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 10_000) return `${trimNumber(durationMs / 1_000, 1)}s`;
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return seconds === 60 ? `${minutes + 1}m 0s` : `${minutes}m ${seconds}s`;
}

export function formatTokenCount(tokens: number | undefined): string | undefined {
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return undefined;
  if (tokens < 1_000) return `${Math.round(tokens)} tokens`;
  return `${trimNumber(tokens / 1_000, 1)}k tokens`;
}

export function formatTurnMetrics(metrics: TurnResponseMetrics | undefined, status: TurnResponseStatus, now: number): string | undefined {
  if (metrics === undefined) return undefined;
  const end = metrics.completedAt ?? (status === "streaming" ? new Date(now).toISOString() : undefined);
  const duration = formatDuration(getDurationMs(metrics.startedAt, end));
  const tokens = metrics.usage === null ? undefined : formatTokenCount(metrics.usage.totalTokens);
  const statusLabel = status === "streaming" ? "Running" : status === "aborted" ? "Stopped" : status === "failed" ? "Failed" : undefined;
  const parts = [statusLabel, duration, tokens, metrics.toolCount > 0 ? `${metrics.toolCount} ${metrics.toolCount === 1 ? "tool" : "tools"}` : undefined].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function trimNumber(value: number, decimals: number): string {
  return value.toFixed(decimals).replace(/\.0+$/, "");
}
