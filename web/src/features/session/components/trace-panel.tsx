import { Activity, ArrowLeft, Layers, RefreshCw, Sparkles, Wrench, X } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import { humanizeToolName } from "../turn-stream-projection";
import { formatDuration } from "../turn-metrics";
import type {
  TraceSpanResponse,
  TraceSpanStatus,
  TurnTraceResponse,
  TurnTraceStatus,
} from "../../../api/sessions/turn-trace-contracts";

type TracePanelProps = {
  turnId: string;
  trace: TurnTraceResponse | null;
  isLoading: boolean;
  error: unknown | null;
  onRefresh: () => void;
  onBack?: () => void;
  onClose?: () => void;
  isMobile?: boolean;
};

export type TraceSummary = {
  modelCallCount: number;
  toolCallCount: number;
  totalTokens: number;
  attemptCount: number;
};

export type TraceAttemptGroup = {
  attempt: number;
  spans: TraceSpanResponse[];
};

export function getTraceSummary(spans: readonly TraceSpanResponse[]): TraceSummary {
  const attempts = new Set(spans.map((span) => span.attempt));
  return {
    modelCallCount: spans.filter((span) => span.kind === "model").length,
    toolCallCount: spans.filter((span) => span.kind === "tool").length,
    totalTokens: spans.reduce((total, span) => total + (span.kind === "model" ? span.usage?.totalTokens ?? 0 : 0), 0),
    attemptCount: attempts.size,
  };
}

/** Groups attempts by their first appearance while preserving Backend span order within each attempt. */
export function groupTraceSpansByAttempt(spans: readonly TraceSpanResponse[]): TraceAttemptGroup[] {
  const groups = new Map<number, TraceAttemptGroup>();
  for (const span of spans) {
    const group = groups.get(span.attempt);
    if (group === undefined) {
      groups.set(span.attempt, { attempt: span.attempt, spans: [span] });
    } else {
      group.spans.push(span);
    }
  }
  return [...groups.values()];
}

export function getTraceSpanLabel(span: TraceSpanResponse): string {
  if (span.kind === "model") return "Model call";
  if (span.kind === "tool") return humanizeToolName(span.name);
  return "Context compaction";
}

export function TracePanel({
  turnId,
  trace,
  isLoading,
  error,
  onRefresh,
  onBack,
  onClose,
  isMobile = false,
}: TracePanelProps) {
  const [expandedSpanId, setExpandedSpanId] = useState<string | null>(null);
  const groups = trace === null ? [] : groupTraceSpansByAttempt(trace.spans);

  return (
    <aside
      className={cn(
        "flex w-full shrink-0 flex-col border-line bg-[#f8fafc] xl:w-[320px] xl:border-l",
        isMobile ? "fixed inset-y-0 right-0 z-40 max-w-[360px] border-l bg-[#f8fafc] shadow-panel" : "hidden xl:flex",
      )}
      aria-label="Developer trace"
    >
      <header className="flex min-h-16 items-center justify-between gap-3 border-b border-line px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand" aria-hidden="true">
            <Activity size={16} strokeWidth={2.1} />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-ink">Developer trace</p>
            <p className="mt-0.5 truncate text-[11px] text-mutedInk" title={turnId}>Turn {shortenTurnId(turnId)}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRefresh} disabled={isLoading} aria-label="Refresh developer trace" title="Refresh">
            <RefreshCw size={15} className={cn(isLoading && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
          </Button>
          {onBack && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack} aria-label="Back to run context" title="Back to run context"><ArrowLeft size={16} aria-hidden="true" /></Button>}
          {isMobile && onClose && <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label="Close developer trace" title="Close"><X size={16} aria-hidden="true" /></Button>}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" aria-busy={isLoading}>
        {isLoading && trace === null && <TraceLoadingState />}
        {!isLoading && error !== null && <TraceErrorState onRetry={onRefresh} />}
        {!isLoading && error === null && trace !== null && (
          <TraceContent trace={trace} groups={groups} expandedSpanId={expandedSpanId} onToggleSpan={(spanId) => setExpandedSpanId((current) => current === spanId ? null : spanId)} />
        )}
      </div>
    </aside>
  );
}

function TraceContent({
  trace,
  groups,
  expandedSpanId,
  onToggleSpan,
}: {
  trace: TurnTraceResponse;
  groups: TraceAttemptGroup[];
  expandedSpanId: string | null;
  onToggleSpan: (spanId: string) => void;
}) {
  const summary = getTraceSummary(trace.spans);

  return (
    <>
      <TraceSummaryCard trace={trace} summary={summary} />
      <section className="mt-6" aria-labelledby="trace-timeline-title">
        <div className="flex items-center justify-between gap-2">
          <h2 id="trace-timeline-title" className="text-[11px] font-semibold uppercase tracking-[0.13em] text-mutedInk">Execution timeline</h2>
          <span className="text-[10px] tabular-nums text-mutedInk">{trace.spans.length} {trace.spans.length === 1 ? "span" : "spans"}</span>
        </div>
        {trace.spans.length === 0 ? (
          <div className="mt-3 rounded-lg border border-dashed border-line px-3 py-3.5 text-[11px] leading-5 text-mutedInk">
            <p>No execution spans recorded yet.</p>
            {trace.status === "running" && <p className="mt-1">Execution details will appear as durable events are recorded.</p>}
          </div>
        ) : (
          <div className="mt-3 space-y-5">
            {groups.map((group) => (
              <section key={group.attempt} aria-labelledby={`trace-attempt-${group.attempt}`}>
                <h3 id={`trace-attempt-${group.attempt}`} className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-mutedInk">Attempt {group.attempt}</h3>
                <div>
                  {group.spans.map((span, index) => (
                    <TraceSpanRow
                      key={span.id}
                      span={span}
                      isLast={index === group.spans.length - 1}
                      isExpanded={expandedSpanId === span.id}
                      onToggle={() => onToggleSpan(span.id)}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function TraceSummaryCard({ trace, summary }: { trace: TurnTraceResponse; summary: TraceSummary }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-3.5 shadow-hairline" aria-label="Trace summary">
      <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent/[0.12] text-accent" aria-hidden="true"><Activity size={14} /></div>
          <p className="text-xs font-semibold text-ink">Turn summary</p>
        </div>
        <Badge tone={getTurnStatusTone(trace.status)}>{getTurnStatusLabel(trace.status)}</Badge>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
        <SummaryMetric label="Duration" value={formatTraceDuration(trace.durationMs)} />
        <SummaryMetric label="Model calls" value={formatCount(summary.modelCallCount, "model call", "model calls")} />
        <SummaryMetric label="Tool calls" value={formatCount(summary.toolCallCount, "tool", "tools")} />
        <SummaryMetric label="Tokens" value={`${summary.totalTokens.toLocaleString()} tokens`} />
        <SummaryMetric label="Attempts" value={formatCount(summary.attemptCount, "attempt", "attempts")} />
        <SummaryMetric label="Spans" value={formatCount(trace.spans.length, "span", "spans")} />
      </div>
    </section>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <div className="min-w-0"><p className="text-[10px] text-mutedInk">{label}</p><p className="mt-0.5 truncate text-xs font-semibold tabular-nums text-ink">{value}</p></div>;
}

function TraceSpanRow({
  span,
  isLast,
  isExpanded,
  onToggle,
}: {
  span: TraceSpanResponse;
  isLast: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const detailId = `trace-span-detail-${span.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const statusLabel = getSpanStatusLabel(span.status);
  const details = getTraceSpanDetails(span);

  return (
    <div className="relative">
      {!isLast && <span className="absolute left-3 top-8 bottom-0 w-px bg-line" aria-hidden="true" />}
      <button
        type="button"
        className="relative z-10 flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-1 py-2 text-left transition duration-200 hover:bg-slate-100/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
        onClick={onToggle}
        aria-expanded={isExpanded}
        aria-controls={isExpanded ? detailId : undefined}
      >
        <SpanIcon span={span} />
        <span className="min-w-0 flex-1 pt-0.5">
          <span className={cn("block truncate text-xs font-semibold", span.status === "error" ? "text-danger" : span.status === "incomplete" ? "text-mutedInk" : "text-ink")}>{getTraceSpanLabel(span)}</span>
          <span className="mt-0.5 block truncate font-mono text-[10px] text-mutedInk">{getTraceSpanIdentity(span)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="text-[11px] tabular-nums text-mutedInk">{formatTraceDuration(span.durationMs)}</span>
          <Badge tone={getSpanStatusTone(span.status)}>{statusLabel}</Badge>
        </span>
      </button>
      {isExpanded && <div id={detailId} className="relative z-10 ml-[38px] mr-1 mb-2 rounded-lg border border-line bg-slate-50/80 px-3 py-2.5"><dl className="grid grid-cols-2 gap-x-3 gap-y-2">{details.map((detail) => <TraceDetail key={detail.label} detail={detail} />)}</dl></div>}
    </div>
  );
}

function TraceDetail({ detail }: { detail: TraceDetail }) {
  return <div className="min-w-0"><dt className="text-[9px] font-semibold uppercase tracking-[0.08em] text-mutedInk">{detail.label}</dt><dd className={cn("mt-0.5 text-[10px] text-ink", detail.mono && "break-all font-mono")}>{detail.value}</dd></div>;
}

type TraceDetail = { label: string; value: string; mono?: boolean };

export function getTraceSpanDetails(span: TraceSpanResponse): TraceDetail[] {
  const common = [
    { label: "Attempt", value: String(span.attempt) },
    { label: "Start sequence", value: formatSequence(span.startSequence) },
    { label: "End sequence", value: formatSequence(span.endSequence) },
    { label: "Started", value: formatTraceDate(span.startedAt) },
    { label: "Ended", value: formatTraceDate(span.endedAt) },
    { label: "Duration", value: formatTraceDuration(span.durationMs) },
  ];

  if (span.kind === "model") {
    return [
      { label: "Model call ID", value: span.modelCallId, mono: true },
      ...common,
      { label: "Input tokens", value: formatTokens(span.usage?.inputTokens) },
      { label: "Output tokens", value: formatTokens(span.usage?.outputTokens) },
      { label: "Total tokens", value: formatTokens(span.usage?.totalTokens) },
    ];
  }

  if (span.kind === "tool") {
    return [
      { label: "Call ID", value: span.callId, mono: true },
      { label: "Name", value: span.name, mono: true },
      { label: "Attempt", value: String(span.attempt) },
      { label: "Requested", value: formatTraceDate(span.requestedAt) },
      { label: "Started", value: formatTraceDate(span.startedAt) },
      { label: "Ended", value: formatTraceDate(span.endedAt) },
      { label: "Duration", value: formatTraceDuration(span.durationMs) },
      { label: "Error", value: span.isError ? "Yes" : "No" },
    ];
  }

  return [
    ...common,
    { label: "Entry ID", value: span.entryId ?? "—", mono: span.entryId !== undefined },
    { label: "Session leaf ID", value: span.sessionLeafId ?? "—", mono: span.sessionLeafId !== undefined },
  ];
}

function SpanIcon({ span }: { span: TraceSpanResponse }) {
  const Icon = span.kind === "model" ? Sparkles : span.kind === "tool" ? Wrench : Layers;
  return <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full", getSpanIconClasses(span.status))} aria-hidden="true"><Icon size={13} /></span>;
}

function TraceLoadingState() {
  return <div className="space-y-5" aria-label="Loading trace"><div className="rounded-xl border border-line bg-surface p-3.5 shadow-hairline"><div className="h-4 w-28 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" /><div className="mt-4 grid grid-cols-2 gap-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-7 animate-pulse rounded bg-slate-100 motion-reduce:animate-none" />)}</div></div><div className="space-y-3">{Array.from({ length: 4 }, (_, index) => <div key={index} className="h-12 animate-pulse rounded-lg bg-slate-100 motion-reduce:animate-none" />)}</div></div>;
}

function TraceErrorState({ onRetry }: { onRetry: () => void }) {
  return <div className="rounded-xl border border-danger/20 bg-danger/[0.05] p-3.5" role="alert"><p className="text-xs font-semibold text-danger">Unable to load trace.</p><Button variant="outline" size="sm" className="mt-3 min-h-8 border-danger/25 text-danger hover:border-danger/40 hover:bg-danger/[0.04]" onClick={onRetry}>Retry</Button></div>;
}

function getTraceSpanIdentity(span: TraceSpanResponse): string {
  if (span.kind === "model") return formatTraceIdentifier(span.modelCallId);
  if (span.kind === "tool") return formatTraceIdentifier(span.callId);
  const identifier = span.entryId ?? span.sessionLeafId;
  return identifier === undefined || identifier === null ? "Compaction span" : formatTraceIdentifier(identifier);
}

function getSpanIconClasses(status: TraceSpanStatus): string {
  if (status === "error") return "bg-danger/10 text-danger";
  if (status === "incomplete") return "bg-orange-50 text-[#b6532e]";
  return "bg-teal/10 text-teal";
}

function getSpanStatusTone(status: TraceSpanStatus) {
  if (status === "error") return "danger" as const;
  if (status === "incomplete") return "orange" as const;
  return "teal" as const;
}

function getSpanStatusLabel(status: TraceSpanStatus): string {
  if (status === "error") return "Error";
  if (status === "incomplete") return "Incomplete";
  return "Completed";
}

function getTurnStatusTone(status: TurnTraceStatus) {
  if (status === "running") return "orange" as const;
  if (status === "completed") return "teal" as const;
  if (status === "failed") return "danger" as const;
  return "neutral" as const;
}

function getTurnStatusLabel(status: TurnTraceStatus): string {
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  return "Cancelled";
}

export function formatTraceDuration(durationMs: number | null): string {
  return formatDuration(durationMs ?? undefined) ?? "—";
}

export function formatTraceIdentifier(identifier: string): string {
  const prefixLength = 10;
  const suffixLength = 4;
  if (identifier.length <= prefixLength + suffixLength + 1) return identifier;
  return `${identifier.slice(0, prefixLength)}…${identifier.slice(-suffixLength)}`;
}

function formatTokens(tokens: number | undefined): string {
  return tokens === undefined ? "—" : tokens.toLocaleString();
}

function formatCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatSequence(sequence: number | null): string {
  return sequence === null ? "—" : String(sequence);
}

function formatTraceDate(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function shortenTurnId(turnId: string): string {
  return turnId.length > 12 ? `${turnId.slice(0, 12)}…` : turnId;
}
