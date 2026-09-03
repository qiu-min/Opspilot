import { Activity, ChevronDown, MoreHorizontal, PanelRight, Share2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

type ConversationHeaderProps = {
  onToggleContext: () => void;
  isContextVisible: boolean;
};

export function ConversationHeader({ onToggleContext, isContextVisible }: ConversationHeaderProps) {
  return (
    <header className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand" aria-hidden="true">
          <Activity size={18} strokeWidth={2.2} />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-semibold tracking-[-0.01em] text-ink">Revenue variance review</h1>
            <Badge tone="teal" className="hidden sm:inline-flex"><span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden="true" />Live</Badge>
          </div>
          <p className="truncate text-[11px] text-mutedInk">Workspace / Conversations / Q2 analysis</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1 sm:gap-2">
        <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label="Share conversation" title="Share conversation">
          <Share2 size={17} aria-hidden="true" />
        </Button>
        <Button variant="ghost" size="icon" className="hidden sm:inline-flex" aria-label="More conversation actions" title="More actions">
          <MoreHorizontal size={18} aria-hidden="true" />
        </Button>
        <Button variant={isContextVisible ? "outline" : "ghost"} size="icon" className="xl:hidden" onClick={onToggleContext} aria-label="Toggle run context" aria-pressed={isContextVisible} title="Run context">
          <PanelRight size={17} aria-hidden="true" />
        </Button>
        <Button variant="outline" size="sm" className="hidden sm:inline-flex">
          Atlas
          <ChevronDown size={14} aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
