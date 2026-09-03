import { Check, ChevronRight, Database, FileSpreadsheet, FileText, Gauge, Info, MoreHorizontal, Sparkles, X } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { cn } from "../../../lib/utils";
import type { AgentExecutionStatus, ConnectedTool, ContextFile, RecentOutput, RunContextStatus } from "../types";

type ContextPanelProps = {
  status: RunContextStatus;
  files: ContextFile[];
  tools: ConnectedTool[];
  outputs: RecentOutput[];
  isMobile?: boolean;
  onClose?: () => void;
};

function getFileIcon(kind: ContextFile["kind"] | RecentOutput["kind"]) {
  return kind === "pdf" ? FileText : FileSpreadsheet;
}

function getStatusTone(status: AgentExecutionStatus) {
  if (status === "failed") return "danger" as const;
  if (status === "running") return "orange" as const;
  if (status === "complete") return "teal" as const;
  return "neutral" as const;
}

function getToolIcon(icon: ConnectedTool["icon"]) {
  return icon === "sparkles" ? Sparkles : Database;
}

export function ContextPanel({ status, files, tools, outputs, isMobile = false, onClose }: ContextPanelProps) {
  return (
    <aside className={cn("flex w-full shrink-0 flex-col border-line bg-[#f8fafc] xl:w-[320px] xl:border-l", isMobile ? "fixed inset-y-0 right-0 z-40 max-w-[360px] border-l bg-[#f8fafc] shadow-panel" : "hidden xl:flex")} aria-label="Run context">
      <div className="flex min-h-16 items-center justify-between border-b border-line px-5">
        <div><p className="text-xs font-semibold text-ink">Run context</p><p className="mt-0.5 text-[11px] text-mutedInk">{status.updatedLabel}</p></div>
        {isMobile ? <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close run context" title="Close"><X size={17} aria-hidden="true" /></Button> : <Button variant="ghost" size="icon" aria-label="More run context actions" title="More actions"><MoreHorizontal size={17} aria-hidden="true" /></Button>}
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="rounded-xl border border-line bg-surface p-3.5 shadow-hairline">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/[0.12] text-accent" aria-hidden="true"><Gauge size={16} /></div>
            <div className="min-w-0">
              <div className="flex items-center gap-2"><p className="text-xs font-semibold text-ink">{status.title}</p><Badge tone={getStatusTone(status.state)}>{status.statusLabel}</Badge></div>
              <p className="mt-1 text-[11px] leading-5 text-mutedInk">{status.detail}</p>
            </div>
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-[10px] text-mutedInk"><span>{status.runLabel}</span>{status.progressLabel && <span className="font-semibold text-[#b6532e]">{status.progressLabel}</span>}</div>
          {status.progress !== undefined && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={status.progress}><div className="h-full rounded-full bg-accent" style={{ width: `${status.progress}%` }} /></div>}
        </div>

        <section className="mt-7" aria-labelledby="working-set-title">
          <div className="flex items-center justify-between"><h2 id="working-set-title" className="text-[11px] font-semibold uppercase tracking-[0.13em] text-mutedInk">Working set</h2><Button variant="ghost" size="icon" className="h-8 w-8" aria-label="Working set info" title="Working set info"><Info size={14} aria-hidden="true" /></Button></div>
          <div className="mt-3 space-y-2">
            {files.map((file) => { const Icon = getFileIcon(file.kind); return <div key={file.id} className="flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2.5"><div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-teal/10 text-teal" aria-hidden="true"><Icon size={15} /></div><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-ink">{file.name}</p><p className="mt-0.5 text-[10px] text-mutedInk">{file.detail}</p></div><Check size={14} className="shrink-0 text-teal" aria-label={file.statusLabel} /></div>; })}
          </div>
        </section>

        <section className="mt-7" aria-labelledby="tools-title">
          <div className="flex items-center justify-between"><h2 id="tools-title" className="text-[11px] font-semibold uppercase tracking-[0.13em] text-mutedInk">Connected tools</h2><Badge tone="teal">{tools.length} active</Badge></div>
          <div className="mt-3 space-y-2">
            {tools.map((tool) => { const ToolIcon = getToolIcon(tool.icon); return <div key={tool.id} className="flex items-center gap-2.5 px-1 py-1.5"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-100 text-mutedInk" aria-hidden="true"><ToolIcon size={14} /></div><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium text-ink">{tool.title}</p><p className="text-[10px] text-mutedInk">{tool.detail}</p></div><ChevronRight size={14} className="text-slate-300" aria-hidden="true" /></div>; })}
          </div>
        </section>

        <section className="mt-7 border-t border-line pt-5" aria-labelledby="output-title">
          <h2 id="output-title" className="text-[11px] font-semibold uppercase tracking-[0.13em] text-mutedInk">Recent output</h2>
          <div className="mt-3 space-y-2">
            {outputs.length === 0 ? <p className="rounded-lg border border-dashed border-line px-3 py-3 text-[11px] text-mutedInk">No outputs yet.</p> : outputs.map((output) => { const Icon = getFileIcon(output.kind); return <button key={output.id} type="button" className="flex min-h-11 w-full cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-surface px-3 text-left transition hover:border-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-brand/10 text-brand" aria-hidden="true"><Icon size={15} /></div><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-semibold text-ink">{output.name}</p><p className="text-[10px] text-mutedInk">{output.detail}</p></div><ChevronRight size={14} className="text-slate-300" aria-hidden="true" /></button>; })}
          </div>
        </section>
      </div>
    </aside>
  );
}
