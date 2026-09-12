import { Check, CircleDashed, LoaderCircle, Terminal, XCircle } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { cn } from "../../../lib/utils";
import { getDurationMs, formatDuration } from "../turn-metrics";
import { humanizeToolName } from "../turn-stream-projection";
import type { AgentExecutionBlock, TurnResponseBlockStatus } from "../types";

type AgentExecutionCardProps = {
  execution: AgentExecutionBlock;
  now: number;
};

export function AgentExecutionCard({ execution, now }: AgentExecutionCardProps) {
  const executionStatus = getExecutionStatus(execution);

  return (
    <section
      className="overflow-hidden rounded-lg border border-line/80 bg-slate-50/70"
      aria-label={`Agent execution ${getStatusLabel(executionStatus)}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-line/80 bg-surface px-3.5 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-navy text-white" aria-hidden="true">
            <Terminal size={14} strokeWidth={2.1} />
          </div>
          <span className="text-xs font-semibold text-ink">Agent execution</span>
        </div>
        <Badge tone={getStatusTone(executionStatus)}>{getStatusLabel(executionStatus)}</Badge>
      </header>

      <div className="space-y-0 px-3.5 py-1.5">
        {execution.steps.map((step, index) => (
          <div key={step.callId} className="relative flex gap-2.5 py-2.5">
            {index < execution.steps.length - 1 && (
              <span className="absolute left-3 top-8 h-[calc(100%-4px)] w-px bg-line" aria-hidden="true" />
            )}
            <div className="relative z-10 shrink-0">
              <StepIcon status={step.status} />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className={cn(
                    "truncate text-xs font-semibold",
                  step.status === "queued" || step.status === "interrupted"
                    ? "text-mutedInk"
                    : step.status === "failed"
                      ? "text-danger"
                      : "text-ink",
                  )}>
                    {step.display?.title ?? humanizeToolName(step.name)}
                  </p>
                  {step.display?.subject && <p className="mt-0.5 truncate text-[11px] text-mutedInk">{step.display.subject}</p>}
                  {step.display?.detail && <p className="mt-0.5 truncate text-[11px] text-mutedInk/80">{step.display.detail}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {getStepDuration(step, now) && <span className="text-[11px] tabular-nums text-mutedInk">{getStepDuration(step, now)}</span>}
                  <Badge tone={getStatusTone(step.status)}>{getStatusLabel(step.status)}</Badge>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function getStepDuration(step: AgentExecutionBlock["steps"][number], now: number): string | undefined {
  const end = step.status === "running" ? now : step.completedAt;
  return formatDuration(getDurationMs(step.startedAt, end));
}

function StepIcon({ status }: { status: TurnResponseBlockStatus }) {
  if (status === "completed") {
    return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal/[0.12] text-teal"><Check size={13} strokeWidth={2.7} aria-hidden="true" /></span>;
  }
  if (status === "running") {
    return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/[0.12] text-accent"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /></span>;
  }
  if (status === "failed") {
    return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-danger/10 text-danger"><XCircle size={14} aria-hidden="true" /></span>;
  }
  return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-mutedInk"><CircleDashed size={14} aria-hidden="true" /></span>;
}

function getExecutionStatus(execution: AgentExecutionBlock): TurnResponseBlockStatus {
  if (execution.steps.some((step) => step.status === "failed")) return "failed";
  if (execution.steps.some((step) => step.status === "running")) return "running";
  if (execution.steps.some((step) => step.status === "queued")) return "queued";
  if (execution.steps.some((step) => step.status === "interrupted")) return "interrupted";
  return "completed";
}

function getStatusLabel(status: TurnResponseBlockStatus): string {
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "interrupted") return "Interrupted";
  return "Failed";
}

function getStatusTone(status: TurnResponseBlockStatus) {
  if (status === "failed") return "danger" as const;
  if (status === "running") return "orange" as const;
  if (status === "completed") return "teal" as const;
  return "neutral" as const;
}
