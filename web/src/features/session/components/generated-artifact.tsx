import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { Badge } from "../../../components/ui/badge";
import type { GeneratedArtifact } from "../types";

type GeneratedArtifactProps = {
  artifact: GeneratedArtifact;
};

export function GeneratedArtifactCard({ artifact }: GeneratedArtifactProps) {
  const Icon = artifact.kind === "pdf" ? FileText : FileSpreadsheet;

  return (
    <section className="ml-11 max-w-[760px] rounded-xl border border-line bg-surface px-4 py-4 shadow-hairline" aria-labelledby={`artifact-title-${artifact.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal" aria-hidden="true"><Icon size={17} /></div>
          <div className="min-w-0"><div className="flex items-center gap-2"><h2 id={`artifact-title-${artifact.id}`} className="truncate text-xs font-semibold text-ink">{artifact.name}</h2><Badge tone="teal">Generated</Badge></div><p className="mt-1 text-[11px] text-mutedInk">{artifact.detail}</p></div>
        </div>
        <Download size={16} className="shrink-0 text-mutedInk" aria-hidden="true" />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-line/80 pt-3 text-[10px] text-mutedInk"><span>{artifact.generatedAt}</span><span className="tabular-nums">{artifact.size}</span></div>
    </section>
  );
}
