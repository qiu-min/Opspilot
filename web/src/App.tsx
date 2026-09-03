import { Menu, Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { ChatMessageView } from "./components/chat-message";
import { Composer, getFileKind, getFileSize } from "./components/composer";
import { ContextPanel } from "./components/context-panel";
import { ConversationHeader } from "./components/conversation-header";
import { ToolExecutionCard } from "./components/tool-execution-card";
import { Button } from "./components/ui/button";
import { WorkspaceSidebar } from "./components/workspace-sidebar";
import type { Attachment, ChatMessage, ToolStep } from "./types";

const initialMessages: ChatMessage[] = [
  {
    id: "assistant-1",
    role: "assistant",
    body: "I found three drivers behind the gross margin decline in Q2. Freight costs are the largest headwind, while the enterprise mix partially offsets the impact. I’m breaking down the variance now so you can review the decision path before we draft a recommendation.",
    createdAt: "10:42",
  },
  {
    id: "user-1",
    role: "user",
    body: "Compare the Q2 margin bridge with our pricing notes. Call out anything we should address in the next ops review.",
    createdAt: "10:43",
    attachments: [
      { id: "file-1", name: "q2-results.xlsx", size: "4.8 MB", kind: "xlsx" },
      { id: "file-2", name: "pricing-notes.pdf", size: "842 KB", kind: "pdf" },
    ],
  },
];

export default function App() {
  const [activeSection, setActiveSection] = useState("Conversations");
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [draft, setDraft] = useState("");
  const [isProcessing, setIsProcessing] = useState(true);
  const [isToolExpanded, setIsToolExpanded] = useState(false);
  const [isContextVisible, setIsContextVisible] = useState(false);
  const [isMobileNavVisible, setIsMobileNavVisible] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Atlas is analyzing the workbook");
  const [attachments, setAttachments] = useState<Attachment[]>(initialMessages[1].attachments ?? []);

  const toolSteps = useMemo<ToolStep[]>(() => [
    { id: "read", title: "Read workbook", detail: "Loaded 2 sheets · 4,218 rows", duration: "1.8s", status: "complete" },
    { id: "bridge", title: "Calculate margin bridge", detail: isProcessing ? "Comparing price, mix, and freight drivers..." : "Compared price, mix, and freight drivers", duration: isProcessing ? "Running" : "12.4s", status: isProcessing ? "running" : "complete" },
    { id: "recommendation", title: "Draft recommendation", detail: isProcessing ? "Queued next" : "Recommendation ready for review", duration: isProcessing ? "Queued" : "3.1s", status: isProcessing ? "queued" : "complete" },
  ], [isProcessing]);

  function handleNewConversation() {
    setMessages([]);
    setAttachments([]);
    setDraft("");
    setIsProcessing(false);
    setStatusMessage("New conversation ready");
    setIsMobileNavVisible(false);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || isProcessing) return;

    const submittedAttachments = attachments.length > 0 ? [...attachments] : undefined;
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: "user", body, createdAt: "now", attachments: submittedAttachments }]);
    setDraft("");
    setIsProcessing(true);
    setStatusMessage("Atlas is processing your request");

    window.setTimeout(() => {
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", body: "I’ve added that request to the analysis thread. The next pass will keep the same working set and surface any new variance drivers here.", createdAt: "now" }]);
      setIsProcessing(false);
      setStatusMessage("Analysis updated");
    }, 900);
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
        <WorkspaceSidebar activeSection={activeSection} onSectionChange={setActiveSection} onNewConversation={handleNewConversation} />

        <main className="flex min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
          <div className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4 lg:hidden">
            <div className="flex items-center gap-2.5"><button type="button" onClick={() => setIsMobileNavVisible(true)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-mutedInk transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" aria-label="Open workspace navigation"><Menu size={18} aria-hidden="true" /></button><span className="text-sm font-bold tracking-[-0.02em]">opspilot</span></div>
            <Button variant="ghost" size="icon" className="h-9 w-9" aria-label="Search workspace" title="Search"><Search size={17} aria-hidden="true" /></Button>
          </div>
          <ConversationHeader onToggleContext={() => setIsContextVisible((visible) => !visible)} isContextVisible={isContextVisible} />

          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation thread">
              <div className="flex-1 overflow-y-auto scroll-smooth">
                <div className="mx-auto w-full max-w-[920px] px-4 pb-8 pt-6 sm:px-8 sm:pt-8">
                  <div className="mb-7 flex items-center justify-between gap-4">
                    <div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedInk">Conversation</p><p className="mt-1 text-xs text-mutedInk">Today · 10:41 AM</p></div>
                    <div className="hidden items-center gap-2 sm:flex"><span className="text-[11px] text-mutedInk">Data guard</span><span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden="true" /><span className="text-[11px] font-medium text-teal">Protected</span></div>
                  </div>

                  <div className="space-y-7">
                    {messages.length === 0 ? (
                      <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
                        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-brand/10 text-brand" aria-hidden="true"><Plus size={22} /></div>
                        <h2 className="mt-4 text-lg font-semibold tracking-[-0.02em] text-ink">Start a new analysis</h2>
                        <p className="mt-2 max-w-sm text-sm leading-6 text-mutedInk">Upload a workbook or ask Atlas a question about your operations data.</p>
                      </div>
                    ) : (
                      <>
                        <ChatMessageView message={messages[0]} />
                        <ChatMessageView message={messages[1]} />
                        <ToolExecutionCard steps={toolSteps} isExpanded={isToolExpanded} onToggle={() => setIsToolExpanded((expanded) => !expanded)} />
                        {messages.slice(2).map((message) => <ChatMessageView key={message.id} message={message} />)}
                        <section className="ml-11 max-w-[760px] rounded-xl border border-line bg-surface px-4 py-4 shadow-hairline" aria-labelledby="insights-title">
                          <div className="flex items-center justify-between gap-3"><div><h2 id="insights-title" className="text-xs font-semibold text-ink">Margin bridge snapshot</h2><p className="mt-1 text-[11px] text-mutedInk">A concise view of the current analysis</p></div><span className="text-[10px] font-medium text-mutedInk">Auto-saved</span></div>
                          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
                            {[{ label: "Gross margin", value: "31.4%", delta: "−2.6 pts", tone: "text-[#b6532e]" }, { label: "Price impact", value: "+1.1 pts", delta: "Positive", tone: "text-teal" }, { label: "Freight impact", value: "−0.9 pts", delta: "Needs review", tone: "text-[#b6532e]" }].map((stat) => <div key={stat.label} className="rounded-lg bg-[#f8fafc] px-3 py-2.5"><p className="text-[10px] font-medium text-mutedInk">{stat.label}</p><p className="mt-1 text-base font-bold tracking-[-0.02em] text-ink">{stat.value}</p><p className={`mt-0.5 text-[10px] font-semibold ${stat.tone}`}>{stat.delta}</p></div>)}
                          </div>
                          <div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" size="sm">Open result</Button><Button variant="ghost" size="sm">Regenerate</Button></div>
                        </section>
                      </>
                    )}
                  </div>
                </div>
              </div>
              <Composer draft={draft} attachments={attachments} isProcessing={isProcessing} onDraftChange={setDraft} onSubmit={handleSubmit} onAttach={handleAttach} onRemoveAttachment={(id) => setAttachments((current) => current.filter((attachment) => attachment.id !== id))} />
            </section>
            <ContextPanel />
          </div>
        </main>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{statusMessage}</div>

      {isMobileNavVisible && (
        <div className="fixed inset-0 z-40 bg-navy/30 lg:hidden" onClick={() => setIsMobileNavVisible(false)}>
          <div className="h-full w-[min(85vw,300px)]" onClick={(event) => event.stopPropagation()}>
            <div className="flex h-full flex-col bg-navy">
              <div className="flex items-center justify-between border-b border-white/10 px-5 py-3"><span className="text-sm font-bold text-white">Workspace</span><button type="button" onClick={() => setIsMobileNavVisible(false)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-navy-muted hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Close navigation"><X size={17} aria-hidden="true" /></button></div>
              <div className="flex-1"><WorkspaceSidebar mobile activeSection={activeSection} onSectionChange={(section) => { setActiveSection(section); setIsMobileNavVisible(false); }} onNewConversation={handleNewConversation} /></div>
            </div>
          </div>
        </div>
      )}

      {isContextVisible && <div className="fixed inset-0 z-30 bg-navy/20 xl:hidden" onClick={() => setIsContextVisible(false)}><div className="ml-auto h-full max-w-[360px]" onClick={(event) => event.stopPropagation()}><ContextPanel isMobile onClose={() => setIsContextVisible(false)} /></div></div>}
    </div>
  );
}
