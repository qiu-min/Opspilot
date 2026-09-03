import { Check, ChevronDown, CircleDashed, Clock3, Terminal, Zap } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import type { ToolStep } from "../types";
import { cn } from "../lib/utils";

type ToolExecutionCardProps = {
  steps: ToolStep[];
  isExpanded: boolean;
  onToggle: () => void;
};

function StepIcon({ status }: { status: ToolStep["status"] }) {
  if (status === "complete") {
    return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-teal/[0.12] text-teal"><Check size={13} strokeWidth={2.7} aria-hidden="true" /></span>;
  }
  if (status === "running") {
    return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent/[0.12] text-accent"><Zap size={13} fill="currentColor" strokeWidth={2.2} aria-hidden="true" /></span>;
  }
  return <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-mutedInk"><CircleDashed size={14} aria-hidden="true" /></span>;
}

export function ToolExecutionCard({ steps, isExpanded, onToggle }: ToolExecutionCardProps) {
  const activeStep = steps.find((step) => step.status === "running");

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-surface shadow-hairline" aria-labelledby="execution-title">
      <div className="flex items-center justify-between gap-4 border-b border-line/80 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-navy text-white" aria-hidden="true"><Terminal size={16} /></div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 id="execution-title" className="text-xs font-semibold text-ink">Agent execution</h2>
              <Badge tone={activeStep ? "orange" : "teal"}>{activeStep ? "Running" : "Complete"}</Badge>
            </div>
            <p className="mt-0.5 truncate text-[11px] text-mutedInk">Atlas · data analysis toolchain</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={onToggle} aria-expanded={isExpanded} aria-controls="execution-details" aria-label={isExpanded ? "Collapse execution details" : "Expand execution details"} title={isExpanded ? "Collapse details" : "Expand details"}>
          <ChevronDown size={16} className={cn("transition-transform duration-200", isExpanded && "rotate-180")} aria-hidden="true" />
        </Button>
      </div>

      <div className="space-y-0 px-4 py-2">
        {steps.map((step, index) => (
          <div key={step.id} className="relative flex gap-3 py-2.5">
            {index < steps.length - 1 && <span className="absolute left-3 top-9 h-[calc(100%-8px)] w-px bg-line" aria-hidden="true" />}
            <div className="relative z-10 shrink-0"><StepIcon status={step.status} /></div>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-center justify-between gap-3">
                <p className={cn("text-xs font-semibold", step.status === "queued" ? "text-mutedInk" : "text-ink")}>{step.title}</p>
                <span className="shrink-0 text-[10px] tabular-nums text-mutedInk">{step.duration}</span>
              </div>
              <p className="mt-1 text-[11px] leading-5 text-mutedInk">{step.detail}</p>
              {step.status === "running" && <Progress value={68} className="mt-2" />}
            </div>
          </div>
        ))}
      </div>

      {isExpanded && (
        <div id="execution-details" className="border-t border-line/80 bg-[#f8fafc] px-4 py-3">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-mutedInk">
            <Clock3 size={13} aria-hidden="true" />
            Latest tool output
          </div>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-navy px-3 py-2.5 font-mono text-[11px] leading-5 text-[#d4e0ef]" aria-label="Latest tool output log">{`> read workbook --sheet "Q2 summary"\n✓ 4,218 rows loaded\n> calculate margin_bridge --group-by driver\n… evaluating 3 drivers`}</pre>
        </div>
      )}
    </section>
  );
}
