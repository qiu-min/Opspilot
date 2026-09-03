import { Menu, X } from "lucide-react";
import { useState } from "react";
import { demoAgentName, demoComposerAttachments, demoConnectedTools, demoContextFiles, demoContextStatus, demoConversationId, demoConversationSummaries, demoEnvironmentLabel, demoRecentOutputs, demoTimeline } from "./demo";
import { getFileKind, getFileSize } from "../../lib/files";
import type { Attachment, ChatMessage, ConversationItem, ConversationSummary } from "./types";
import { useAuth } from "../auth/auth-provider";
import { Composer, type ComposerSubmitPayload } from "./components/composer";
import { ContextPanel } from "./components/context-panel";
import { ConversationHeader } from "./components/conversation-header";
import { ConversationThread } from "./components/conversation-thread";
import { ConversationSidebar } from "./conversation-sidebar";

function createLocalConversationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `local-${crypto.randomUUID()}`;
  }

  return `local-${Date.now()}`;
}

function formatConversationUpdatedAt(updatedAt: string) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "Recently updated";

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function ConversationPage() {
  const { session } = useAuth();
  const [conversations, setConversations] = useState<ConversationSummary[]>(demoConversationSummaries);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(demoConversationId);
  const [timelinesByConversationId, setTimelinesByConversationId] = useState<Record<string, ConversationItem[]>>({ [demoConversationId]: demoTimeline });
  const [attachmentsByConversationId, setAttachmentsByConversationId] = useState<Record<string, Attachment[]>>({ [demoConversationId]: demoComposerAttachments });
  const [draft, setDraft] = useState("");
  const [isExecutionExpanded, setIsExecutionExpanded] = useState(false);
  const [isContextVisible, setIsContextVisible] = useState(false);
  const [isMobileNavVisible, setIsMobileNavVisible] = useState(false);
  const [statusMessage, setStatusMessage] = useState(demoContextStatus.title);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const timeline = activeConversation ? timelinesByConversationId[activeConversation.id] ?? [] : [];
  const attachments = activeConversation ? attachmentsByConversationId[activeConversation.id] ?? [] : [];
  const isProcessing = timeline.some((item) => item.type === "agent-execution" && item.execution.status === "running");
  const accountEmail = session?.email ?? "Signed-in account";
  const statusLabel = activeConversationId === demoConversationId ? "Live" : "Preview";

  function handleNewConversation() {
    const id = createLocalConversationId();
    const newConversation: ConversationSummary = {
      id,
      title: "New conversation",
      updatedAt: new Date().toISOString(),
    };

    setConversations((current) => [newConversation, ...current]);
    setActiveConversationId(id);
    setTimelinesByConversationId((current) => ({ ...current, [id]: [] }));
    setAttachmentsByConversationId((current) => ({ ...current, [id]: [] }));
    setDraft("");
    setIsExecutionExpanded(false);
    setIsMobileNavVisible(false);
    setStatusMessage("New conversation ready");
  }

  function handleConversationSelect(conversationId: string) {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) return;

    setActiveConversationId(conversationId);
    setDraft("");
    setIsExecutionExpanded(false);
    setIsMobileNavVisible(false);
    setStatusMessage(`Selected ${conversation.title}`);
  }

  function handleSubmit({ body, attachments: submittedAttachments }: ComposerSubmitPayload) {
    if (!activeConversationId) return;

    const message: ChatMessage = {
      id: `message-${Date.now()}`,
      role: "user",
      body,
      createdAt: "now",
      attachments: submittedAttachments.length > 0 ? submittedAttachments : undefined,
    };

    setTimelinesByConversationId((current) => ({
      ...current,
      [activeConversationId]: [...(current[activeConversationId] ?? []), { type: "message", id: message.id, message }],
    }));
    setDraft("");
    setStatusMessage("Message added to the conversation preview");
  }

  function handleAttach(files: FileList) {
    if (!activeConversationId) return;

    const nextFiles = Array.from(files).map((file, index): Attachment => ({
      id: `${file.name}-${file.lastModified}-${index}`,
      name: file.name,
      size: getFileSize(file.size),
      kind: getFileKind(file.name),
    }));

    setAttachmentsByConversationId((current) => ({
      ...current,
      [activeConversationId]: [...(current[activeConversationId] ?? []), ...nextFiles],
    }));
    setStatusMessage(`${nextFiles.length} file${nextFiles.length === 1 ? "" : "s"} attached`);
  }

  function handleRemoveAttachment(id: string) {
    if (!activeConversationId) return;

    setAttachmentsByConversationId((current) => ({
      ...current,
      [activeConversationId]: (current[activeConversationId] ?? []).filter((attachment) => attachment.id !== id),
    }));
  }

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-3 focus:text-sm focus:text-white">Skip to conversation</a>
      <div className="flex min-h-dvh">
        <ConversationSidebar conversations={conversations} activeConversationId={activeConversationId} onConversationSelect={handleConversationSelect} onNewConversation={handleNewConversation} accountEmail={accountEmail} environmentLabel={demoEnvironmentLabel} />

        <main className="flex min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
          <div className="flex h-14 shrink-0 items-center border-b border-line bg-surface px-4 lg:hidden">
            <button type="button" onClick={() => setIsMobileNavVisible(true)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-mutedInk transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" aria-label="Open conversation history"><Menu size={18} aria-hidden="true" /></button>
            <span className="ml-2.5 text-sm font-bold tracking-[-0.02em]">opspilot</span>
          </div>

          <ConversationHeader title={activeConversation?.title ?? "New conversation"} subtitle="Local preview" agentName={demoAgentName} statusLabel={statusLabel} onToggleContext={() => setIsContextVisible((visible) => !visible)} isContextVisible={isContextVisible} />

          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation thread">
              <div className="flex-1 overflow-y-auto scroll-smooth">
                <div className="mx-auto w-full max-w-[920px] px-4 pb-8 pt-6 sm:px-8 sm:pt-8">
                  <div className="mb-7 flex items-center justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedInk">Conversation</p><p className="mt-1 text-xs text-mutedInk">{activeConversation ? formatConversationUpdatedAt(activeConversation.updatedAt) : "New conversation"}</p></div></div>
                  <ConversationThread items={timeline} agentName={demoAgentName} isExecutionExpanded={isExecutionExpanded} onToggleExecution={() => setIsExecutionExpanded((expanded) => !expanded)} />
                </div>
              </div>
              <Composer draft={draft} attachments={attachments} isProcessing={isProcessing} agentName={demoAgentName} onDraftChange={setDraft} onSubmit={handleSubmit} onAttach={handleAttach} onRemoveAttachment={handleRemoveAttachment} />
            </section>
            <ContextPanel status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} />
          </div>
        </main>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{statusMessage}</div>

      {isMobileNavVisible && (
        <div className="fixed inset-0 z-40 bg-navy/30 lg:hidden" onClick={() => setIsMobileNavVisible(false)}>
          <div className="h-full w-[min(85vw,300px)]" role="dialog" aria-modal="true" aria-label="Conversation history" onClick={(event) => event.stopPropagation()}>
            <div className="flex h-full flex-col bg-navy">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3"><span className="text-sm font-bold text-white">Conversation history</span><button type="button" onClick={() => setIsMobileNavVisible(false)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-navy-muted hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Close conversation history"><X size={17} aria-hidden="true" /></button></div>
              <div className="min-h-0 flex-1"><ConversationSidebar mobile conversations={conversations} activeConversationId={activeConversationId} onConversationSelect={handleConversationSelect} onNewConversation={handleNewConversation} accountEmail={accountEmail} environmentLabel={demoEnvironmentLabel} /></div>
            </div>
          </div>
        </div>
      )}

      {isContextVisible && <div className="fixed inset-0 z-30 bg-navy/20 xl:hidden" onClick={() => setIsContextVisible(false)}><div className="ml-auto h-full max-w-[360px]" onClick={(event) => event.stopPropagation()}><ContextPanel isMobile status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} onClose={() => setIsContextVisible(false)} /></div></div>}
    </div>
  );
}
