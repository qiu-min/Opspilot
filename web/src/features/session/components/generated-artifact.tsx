import { Download, FileSpreadsheet, FileText, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { downloadExcelResource } from "../../../api/sessions/session-api";
import { ApiError } from "../../../api/client";
import type { GeneratedArtifact } from "../types";

type GeneratedArtifactProps = {
  artifact: GeneratedArtifact;
  sessionId?: string;
  accessToken?: string;
  onDownloadError?: (message: string) => void;
};

export function GeneratedArtifactCard({ artifact, sessionId, accessToken, onDownloadError }: GeneratedArtifactProps) {
  const Icon = artifact.kind === "pdf" ? FileText : FileSpreadsheet;
  const [isDownloading, setIsDownloading] = useState(false);

  async function handleDownload() {
    if (isDownloading || sessionId === undefined || accessToken === undefined) return;
    setIsDownloading(true);
    try {
      await downloadExcelResource(sessionId, artifact.resourceId, accessToken);
    } catch (error: unknown) {
      onDownloadError?.(downloadErrorMessage(error));
    } finally {
      setIsDownloading(false);
    }
  }

  return (
    <section className="ml-11 max-w-[760px] rounded-xl border border-line bg-surface px-4 py-4 shadow-hairline" aria-labelledby={`artifact-title-${artifact.id}`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal/10 text-teal" aria-hidden="true"><Icon size={17} /></div>
          <div className="min-w-0"><div className="flex items-center gap-2"><h2 id={`artifact-title-${artifact.id}`} className="truncate text-xs font-semibold text-ink">{artifact.name}</h2><Badge tone="teal">Generated</Badge></div><p className="mt-1 text-[11px] text-mutedInk">{artifact.detail}</p></div>
        </div>
        <Button variant="ghost" size="icon" className="shrink-0" onClick={() => void handleDownload()} disabled={isDownloading || sessionId === undefined || accessToken === undefined} aria-label={`Download ${artifact.name}`} aria-busy={isDownloading} title="Download workbook">
          {isDownloading ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}
        </Button>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-line/80 pt-3 text-[10px] text-mutedInk"><span>{artifact.generatedAt}</span><span className="tabular-nums">{artifact.size}</span></div>
    </section>
  );
}

function downloadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.detail || error.title || "Unable to download the workbook.";
  if (error instanceof TypeError) return "Unable to reach OpsPilot. Check your connection and try again.";
  return "Unable to download the workbook. Try again.";
}
