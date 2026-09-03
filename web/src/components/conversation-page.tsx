import { Menu, Search, X } from "lucide-react";
import { useState } from "react";
import { demoAgentName, demoComposerAttachments, demoConnectedTools, demoContextFiles, demoContextStatus, demoConversation, demoRecentOutputs, demoTimeline, demoWorkspace } from "../demo/conversation";
import { getFileKind, getFileSize } from "../lib/files";
import type { Attachment, ChatMessage, ConversationItem } from "../types";
import { ConversationHeader } from "./conversation-header";
import { ConversationThread } from "./conversation-thread";
import { ContextPanel } from "./context-panel";
import type { ComposerSubmitPayload } from "./composer";
import { Composer } from "./composer";
import { Button } from "./ui/button";
import { WorkspaceSidebar } from "./workspace-sidebar";

export function ConversationPage() {
  const [timeline, setTimeline] = useState<ConversationItem[]>(demoTimeline);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>(demoComposerAttachments);
  const [isExecutionExpanded, setIsExecutionExpanded] = useState(false);
  const [isContextVisible, setIsContextVisible] = useState(false);
  const [isMobileNavVisible, setIsMobileNavVisible] = useState(false);
  const [statusMessage, setStatusMessage] = useState(demoContextStatus.title);

  const isProcessing = timeline.some((item) => item.type === "agent-execution" && item.execution.status === "running");

  function handleNewConversation() {
    setTimeline([]);
    setAttachments([]);
    setDraft("");
    setStatusMessage("New conversation ready");
    setIsMobileNavVisible(false);
  }

  function handleSubmit({ body, attachments: submittedAttachments }: ComposerSubmitPayload) {
    const message: ChatMessage = {
      id: `message-${Date.now()}`,
      role: "user",
      body,
      createdAt: "now",
      attachments: submittedAttachments.length > 0 ? submittedAttachments : undefined,
    };

    setTimeline((current) => [...current, { type: "message", id: message.id, message }]);
    setDraft("");
    setStatusMessage("Message added to the conversation preview");
  }

  function handleAttach(files: FileList) {
    const nextFiles = Array.from(files).map((file, index): Attachment => ({
      id: `${file.name}-${file.lastModified}-${index}`,
      name: file.name,
      size: getFileSize(file.size),
      kind: getFileKind(file.name),
    }));

    setAttachments((current) => [...current, ...nextFiles]);
    setStatusMessage(`${nextFiles.length} file${nextFiles.length === 1 ? "" : "s"} attached`);
  }

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-3 focus:text-sm focus:text-white">Skip to conversation</a>
      <div className="flex min-h-dvh">
        <WorkspaceSidebar onNewConversation={handleNewConversation} userName={demoWorkspace.userName} teamName={demoWorkspace.teamName} environmentLabel={demoWorkspace.environmentLabel} />

        <main className="flex min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4 lg:hidden">
            <div className="flex items-center gap-2.5"><button type="button" onClick={() => setIsMobileNavVisible(true)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-mutedInk transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" aria-label="Open workspace navigation"><Menu size={18} aria-hidden="true" /></button><span className="text-sm font-bold tracking-[-0.02em]">opspilot</span></div>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Search workspace" title="Search"><Search size={17} aria-hidden="true" /></Button>
          </div>

          <ConversationHeader title={demoConversation.title} subtitle={demoConversation.subtitle} agentName={demoAgentName} statusLabel={demoConversation.statusLabel} onToggleContext={() => setIsContextVisible((visible) => !visible)} isContextVisible={isContextVisible} />

          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation thread">
              <div className="flex-1 overflow-y-auto scroll-smooth">
                <div className="mx-auto w-full max-w-[920px] px-4 pb-8 pt-6 sm:px-8 sm:pt-8">
                  <div className="mb-7 flex items-center justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedInk">Conversation</p><p className="mt-1 text-xs text-mutedInk">{demoConversation.dateLabel}</p></div></div>
                  <ConversationThread items={timeline} agentName={demoAgentName} isExecutionExpanded={isExecutionExpanded} onToggleExecution={() => setIsExecutionExpanded((expanded) => !expanded)} />
                </div>
              </div>
              <Composer draft={draft} attachments={attachments} isProcessing={isProcessing} agentName={demoAgentName} onDraftChange={setDraft} onSubmit={handleSubmit} onAttach={handleAttach} onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} />
            </section>
            <ContextPanel status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} />
          </div>
        </main>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{statusMessage}</div>

      {isMobileNavVisible && (
        <div className="fixed inset-0 z-40 bg-navy/30 lg:hidden" onClick={() => setIsMobileNavVisible(false)}>
          <div className="h-full w-[min(85vw,300px)]" onClick={(event) => event.stopPropagation()}>
            <div className="flex h-full flex-col bg-navy">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3"><span className="text-sm font-bold text-white">Workspace</span><button type="button" onClick={() => setIsMobileNavVisible(false)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-navy-muted hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Close navigation"><X size={17} aria-hidden="true" /></button></div>
              <div className="flex-1"><WorkspaceSidebar mobile onNewConversation={handleNewConversation} userName={demoWorkspace.userName} teamName={demoWorkspace.teamName} environmentLabel={demoWorkspace.environmentLabel} /></div>
            </div>
          </div>
        </div>
      )}

      {isContextVisible && <div className="fixed inset-0 z-30 bg-navy/20 xl:hidden" onClick={() => setIsContextVisible(false)}><div className="ml-auto h-full max-w-[360px]" onClick={(event) => event.stopPropagation()}><ContextPanel isMobile status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} onClose={() => setIsContextVisible(false)} /></div></div>}
    </div>
  );
}
