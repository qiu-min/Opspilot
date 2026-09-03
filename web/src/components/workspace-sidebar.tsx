import { Bot, ChevronDown, FileText, MessageSquare, Plus, Settings2, Sparkles } from "lucide-react";
import { Button } from "./ui/button";

type WorkspaceSidebarProps = {
  onNewConversation: () => void;
  userName: string;
  teamName: string;
  environmentLabel: string;
  mobile?: boolean;
};

export function WorkspaceSidebar({ onNewConversation, userName, teamName, environmentLabel, mobile = false }: WorkspaceSidebarProps) {
  return (
    <aside className={mobile ? "flex h-full w-full shrink-0 flex-col bg-navy text-white" : "hidden w-[256px] shrink-0 flex-col border-r border-white/10 bg-navy text-white lg:flex"} aria-label="Workspace navigation">
      <div className="flex h-16 items-center justify-between border-b border-white/10 px-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent text-navy shadow-sm" aria-hidden="true"><Sparkles size={16} strokeWidth={2.3} /></div>
          <span className="text-[15px] font-bold tracking-[-0.02em]">opspilot</span>
        </div>
        <button className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-navy-muted transition hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Open workspace switcher" title="Switch workspace"><ChevronDown size={16} aria-hidden="true" /></button>
      </div>

      <div className="px-4 pt-5"><Button variant="primary" size="md" className="w-full justify-start bg-accent/95" onClick={onNewConversation}><Plus size={17} strokeWidth={2.4} aria-hidden="true" />New conversation<span className="ml-auto text-[10px] font-semibold text-white/[0.65]">⌘ K</span></Button></div>

      <nav className="flex-1 px-3 py-6" aria-label="Primary">
        <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-navy-muted/75">Workspace</p>
        <div className="space-y-1">
          <div aria-current="page" className="flex min-h-11 w-full items-center gap-3 rounded-lg bg-white/[0.12] px-3 text-sm font-semibold text-white"><MessageSquare size={17} strokeWidth={2.3} aria-hidden="true" /><span>Conversations</span></div>
          <button type="button" disabled className="flex min-h-11 w-full cursor-not-allowed items-center gap-3 rounded-lg px-3 text-left text-sm text-navy-muted/55" title="Files is unavailable in this preview" aria-label="Files unavailable in this preview"><FileText size={17} strokeWidth={1.8} aria-hidden="true" /><span>Files</span><span className="ml-auto text-[10px]">Unavailable</span></button>
        </div>

        <p className="mt-8 px-3 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-navy-muted/75">Manage</p>
        <div className="space-y-1"><button type="button" disabled className="flex min-h-11 w-full cursor-not-allowed items-center gap-3 rounded-lg px-3 text-left text-sm text-navy-muted/55" title="Settings is unavailable in this preview" aria-label="Settings unavailable in this preview"><Settings2 size={17} strokeWidth={1.8} aria-hidden="true" /><span>Settings</span><span className="ml-auto text-[10px]">Unavailable</span></button></div>
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className="mb-4 flex items-center gap-2 rounded-lg bg-white/[0.06] px-3 py-2.5"><span className="relative flex h-2 w-2" aria-hidden="true"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#4ade80] opacity-50 motion-reduce:animate-none" /><span className="relative inline-flex h-2 w-2 rounded-full bg-[#4ade80]" /></span><span className="text-xs text-navy-muted">{environmentLabel}</span></div>
        <button type="button" className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-2 text-left transition hover:bg-white/[0.08] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Open account menu"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#dce7f6] text-xs font-bold text-navy" aria-hidden="true">{userName.slice(0, 2).toUpperCase()}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-white">{userName}</span><span className="block truncate text-[11px] text-navy-muted">{teamName}</span></span><Bot size={16} className="text-navy-muted" aria-hidden="true" /></button>
      </div>
    </aside>
  );
}
