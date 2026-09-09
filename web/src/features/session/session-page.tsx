import { AlertCircle, Menu, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { createSession, getActiveSessionTurn, getSession, listSessions, reattachSessionTurnStream, startSessionTurnStream } from "../../api/sessions/session-api";
import type { ActiveTurnResponse } from "../../api/sessions/session-contracts";
import { TurnStreamProtocolError, type TurnStreamEvent } from "../../api/sessions/turn-stream-contracts";
import { uploadFile } from "../../api/files/files-api";
import { useAuth } from "../auth/auth-provider";
import { Composer, type ComposerSubmitPayload } from "./components/composer";
import { ContextPanel } from "./components/context-panel";
import { SessionHeader } from "./components/session-header";
import { SessionThread } from "./components/session-thread";
import { SessionSidebar } from "./session-sidebar";
import { demoAgentName, demoConnectedTools, demoContextFiles, demoContextStatus, demoEnvironmentLabel, demoRecentOutputs } from "./demo";
import { isXlsxFile, replacePendingAttachment, uploadPendingAttachment, SessionAttachmentValidationError } from "./session-attachments";
import { formatMessageCreatedAt, mergeLiveTurnResponse, toSessionItems, toSessionSummary } from "./session-mappers";
import { projectTurnStream } from "./turn-stream-projection";
import { createInitialTurnStreamState, hydrateTurnStreamStateFromProjection, reduceTurnStreamEvent, TurnStreamStateError, type TurnStreamState } from "./turn-stream-state";
import type { ChatMessage, PendingAttachment, SessionItem, SessionSummary } from "./types";

let temporaryMessageSequence = 0;
function temporaryMessageId() { temporaryMessageSequence += 1; return `message-${temporaryMessageSequence}`; }
function formatSessionUpdatedAt(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "Recently updated" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date); }
function errorMessage(error: unknown, fallback: string) { if (error instanceof ApiError) return error.detail || error.title || fallback; if (error instanceof TypeError) return "Unable to reach OpsPilot. Check your connection and try again."; return fallback; }

export function SessionPage() {
  const { session: authSession } = useAuth();
  const accessToken = authSession?.accessToken;
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [timelinesBySessionId, setTimelinesBySessionId] = useState<Record<string, SessionItem[]>>({});
  const [activeTurnIdBySessionId, setActiveTurnIdBySessionId] = useState<Record<string, string | undefined>>({});
  const [turnStreamStatesByTurnId, setTurnStreamStatesByTurnId] = useState<Record<string, TurnStreamState | undefined>>({});
  const turnStreamStatesRef = useRef<Record<string, TurnStreamState | undefined>>({});
  const turnStreamControllersByTurnId = useRef(new Map<string, AbortController>());
  const [attachmentsBySessionId, setAttachmentsBySessionId] = useState<Record<string, PendingAttachment[]>>({});
  const [processingSessionIds, setProcessingSessionIds] = useState<Set<string>>(new Set());
  const processingSessionIdsRef = useRef(new Set<string>());
  const [statusBySessionId, setStatusBySessionId] = useState<Record<string, string | undefined>>({});
  const [errorsBySessionId, setErrorsBySessionId] = useState<Record<string, string | undefined>>({});
  const [loadingSessionIds, setLoadingSessionIds] = useState<Record<string, boolean>>({});
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [isCreatingSession, setIsCreatingSession] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [sessionListError, setSessionListError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [isContextVisible, setIsContextVisible] = useState(false);
  const [isMobileNavVisible, setIsMobileNavVisible] = useState(false);
  const [pageStatus, setPageStatus] = useState("Ready");
  const listController = useRef<AbortController | null>(null);
  const sessionController = useRef<AbortController | null>(null);

  const setSessionStatus = useCallback((sessionId: string, status: string) => setStatusBySessionId((current) => ({ ...current, [sessionId]: status })), []);
  const setTurnState = useCallback((turnId: string, state: TurnStreamState) => {
    turnStreamStatesRef.current = { ...turnStreamStatesRef.current, [turnId]: state };
    setTurnStreamStatesByTurnId((current) => ({ ...current, [turnId]: state }));
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!accessToken) return;
    listController.current?.abort();
    const controller = new AbortController(); listController.current = controller; setIsLoadingSessions(true);
    try {
      const next = (await listSessions(accessToken, controller.signal)).map(toSessionSummary);
      if (controller.signal.aborted) return;
      setSessions(next); setActiveSessionId((current) => current && next.some((item) => item.id === current) ? current : next[0]?.id ?? null); setSessionListError(null); setPageError(null);
    } catch (error: unknown) { if (!controller.signal.aborted) { const message = errorMessage(error, "Unable to load sessions. Try again."); setSessionListError(message); setPageError(message); } }
    finally { if (listController.current === controller) { listController.current = null; setIsLoadingSessions(false); } }
  }, [accessToken]);

  useEffect(() => { if (!accessToken) { setSessions([]); setActiveSessionId(null); return; } void refreshSessions(); return () => listController.current?.abort(); }, [accessToken, refreshSessions]);

  const loadSession = useCallback(async (sessionId: string) => {
    if (!accessToken) return;
    sessionController.current?.abort(); const controller = new AbortController(); sessionController.current = controller;
    setLoadingSessionIds((current) => ({ ...current, [sessionId]: true }));
    try {
      const [detail, active] = await Promise.all([getSession(sessionId, accessToken, controller.signal), getActiveSessionTurn(sessionId, accessToken, controller.signal)]);
      if (controller.signal.aborted) return;
      const durableItems = toSessionItems(detail); setTimelinesBySessionId((current) => ({ ...current, [sessionId]: durableItems }));
      await hydrateAndReattach(sessionId, active, false);
    } catch (error: unknown) { if (!controller.signal.aborted) setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "Unable to load this session. Try selecting it again.") })); }
    finally { if (sessionController.current === controller) { sessionController.current = null; setLoadingSessionIds((current) => ({ ...current, [sessionId]: false })); } }
  }, [accessToken]);

  useEffect(() => { if (activeSessionId) void loadSession(activeSessionId); return () => sessionController.current?.abort(); }, [activeSessionId, loadSession]);

  async function hydrateAndReattach(sessionId: string, active: ActiveTurnResponse, retry: boolean) {
    if (active.activeTurn === null) { setActiveTurnIdBySessionId((current) => ({ ...current, [sessionId]: undefined })); return; }
    const { turnId, projection } = active.activeTurn; setActiveTurnIdBySessionId((current) => ({ ...current, [sessionId]: turnId }));
    const existing = turnStreamStatesRef.current[turnId]; if (existing === undefined) setTurnState(turnId, hydrateTurnStreamStateFromProjection(projection));
    if (!turnStreamControllersByTurnId.current.has(turnId)) {
      const controller = new AbortController(); turnStreamControllersByTurnId.current.set(turnId, controller);
      await consumeTurnStream(sessionId, turnId, reattachSessionTurnStream(sessionId, turnId, projection.lastSequence, accessToken!, controller.signal), controller, !retry);
    }
  }

  async function consumeTurnStream(sessionId: string, expectedTurnId: string | undefined, stream: AsyncGenerator<TurnStreamEvent>, controller: AbortController, allowRecovery: boolean) {
    let turnId = expectedTurnId; let terminal = false;
    try {
      for await (const event of stream) {
        if (turnId !== undefined && event.turnId !== turnId) throw new TurnStreamStateError("Turn stream changed Turn identity.");
        turnId ??= event.turnId;
        if (!turnStreamControllersByTurnId.current.has(turnId)) turnStreamControllersByTurnId.current.set(turnId, controller);
        const current = turnStreamStatesRef.current[turnId] ?? createInitialTurnStreamState(turnId, sessionId);
        const next = reduceTurnStreamEvent(current, event); setTurnState(turnId, next); setActiveTurnIdBySessionId((value) => ({ ...value, [sessionId]: turnId }));
        if (event.type === "turn_started") setSessionStatus(sessionId, "Processing your request");
        if (event.type === "assistant_thinking_started") setSessionStatus(sessionId, "Assistant is thinking");
        if (event.type === "assistant_text_delta") setSessionStatus(sessionId, "Assistant is responding");
        if (event.type === "tool_started") setSessionStatus(sessionId, `Running ${event.name}`);
        if (event.type === "tool_completed") setSessionStatus(sessionId, event.isError ? `${event.name} failed` : `${event.name} completed`);
        if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_cancelled") { terminal = true; await reconcileTerminalSession(sessionId, turnId); break; }
      }
      if (!terminal && !controller.signal.aborted && allowRecovery) {
        releaseTurnStreamController(turnId, controller);
        await recoverDisconnectedTurn(sessionId, turnId);
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 409 && allowRecovery) {
        releaseTurnStreamController(turnId, controller);
        await recoverDisconnectedTurn(sessionId, turnId);
        return;
      }
      if (allowRecovery) {
        releaseTurnStreamController(turnId, controller);
        await recoverDisconnectedTurn(sessionId, turnId);
        return;
      }
      setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "The live stream could not be restored.") }));
    } finally { releaseTurnStreamController(turnId, controller); }
  }

  async function recoverDisconnectedTurn(sessionId: string, turnId: string | undefined) {
    if (!accessToken || turnId === undefined) return;
    try { const active = await getActiveSessionTurn(sessionId, accessToken); await hydrateAndReattach(sessionId, active, true); if (active.activeTurn === null) await loadSession(sessionId); }
    catch (error: unknown) { setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "Unable to reattach the active Turn.") })); }
  }

  function releaseTurnStreamController(turnId: string | undefined, controller: AbortController) {
    if (turnId !== undefined && turnStreamControllersByTurnId.current.get(turnId) === controller) turnStreamControllersByTurnId.current.delete(turnId);
  }

  async function reconcileTerminalSession(sessionId: string, turnId: string) {
    if (!accessToken) return;
    try { const detail = await getSession(sessionId, accessToken); setTimelinesBySessionId((current) => ({ ...current, [sessionId]: toSessionItems(detail) })); setActiveTurnIdBySessionId((current) => ({ ...current, [sessionId]: undefined })); turnStreamStatesRef.current = Object.fromEntries(Object.entries(turnStreamStatesRef.current).filter(([id]) => id !== turnId)); setTurnStreamStatesByTurnId((current) => { const next = { ...current }; delete next[turnId]; return next; }); await refreshSessions(); setSessionStatus(sessionId, "Response completed"); }
    catch (error: unknown) { setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "Unable to refresh the completed Session.") })); }
  }

  async function handleNewSession() {
    if (!accessToken || isCreatingSession) return; setIsCreatingSession(true);
    try { const created = toSessionSummary(await createSession(accessToken)); setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]); setActiveSessionId(created.id); setTimelinesBySessionId((current) => ({ ...current, [created.id]: [] })); setAttachmentsBySessionId((current) => ({ ...current, [created.id]: [] })); setPageStatus("New session ready"); setIsMobileNavVisible(false); }
    catch (error: unknown) { setPageError(errorMessage(error, "Unable to create a Session. Try again.")); }
    finally { setIsCreatingSession(false); }
  }

  async function handleSubmit({ body, attachments }: ComposerSubmitPayload) {
    const sessionId = activeSessionId; if (!sessionId || !accessToken || processingSessionIdsRef.current.has(sessionId)) return;
    if (!body.trim()) return;
    if (attachments.length > 1 || attachments.some((attachment) => !isXlsxFile(attachment.file))) { setErrorsBySessionId((current) => ({ ...current, [sessionId]: "Only one .xlsx file can be sent per message." })); return; }
    processingSessionIdsRef.current.add(sessionId); setProcessingSessionIds(new Set(processingSessionIdsRef.current)); const controller = new AbortController();
    let optimisticId: string | undefined;
    try {
      const uploaded = await uploadPendingAttachment(attachments, accessToken, controller.signal, uploadFile); const message: ChatMessage = { id: temporaryMessageId(), role: "user", body: body.trim(), createdAt: formatMessageCreatedAt(), ...(uploaded.attachment === undefined ? {} : { attachments: [uploaded.attachment] }) }; optimisticId = message.id;
      setTimelinesBySessionId((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { type: "message", id: message.id, message }] })); setDraft(""); setAttachmentsBySessionId((current) => ({ ...current, [sessionId]: [] })); setSessionStatus(sessionId, "Processing your request");
      const stream = startSessionTurnStream(sessionId, { message: body.trim(), fileId: uploaded.fileId }, accessToken, controller.signal); await consumeTurnStream(sessionId, undefined, stream, controller, true);
    } catch (error: unknown) { if (!controller.signal.aborted) setErrorsBySessionId((current) => ({ ...current, [sessionId]: error instanceof SessionAttachmentValidationError ? error.message : errorMessage(error, "The request failed. Try again.") })); }
    finally { if (optimisticId !== undefined) setTimelinesBySessionId((current) => current); processingSessionIdsRef.current.delete(sessionId); setProcessingSessionIds(new Set(processingSessionIdsRef.current)); }
  }

  function handleSessionSelect(sessionId: string) { if (!sessions.some((item) => item.id === sessionId)) return; setActiveSessionId(sessionId); setDraft(""); setIsMobileNavVisible(false); }
  function handleAttach(files: FileList) { if (!activeSessionId || files.length === 0) return; setAttachmentsBySessionId((current) => ({ ...current, [activeSessionId]: replacePendingAttachment(files[0]) })); }
  function handleRemoveAttachment(id: string) { if (!activeSessionId) return; setAttachmentsBySessionId((current) => ({ ...current, [activeSessionId]: (current[activeSessionId] ?? []).filter((item) => item.id !== id) })); }

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const durableTimeline = activeSessionId ? timelinesBySessionId[activeSessionId] ?? [] : [];
  const activeTurnId = activeSessionId ? activeTurnIdBySessionId[activeSessionId] : undefined;
  const activeState = activeTurnId ? turnStreamStatesByTurnId[activeTurnId] : undefined;
  const liveResponse = activeState ? projectTurnStream(activeState, `turn-${activeState.turnId}`) : undefined;
  const timeline = mergeLiveTurnResponse(durableTimeline, liveResponse, liveResponse?.id);
  const isProcessing = activeSessionId !== null && processingSessionIds.has(activeSessionId);
  const attachments = activeSessionId ? attachmentsBySessionId[activeSessionId] ?? [] : [];
  const sessionError = activeSessionId ? errorsBySessionId[activeSessionId] : undefined;
  const visibleError = sessionError ?? pageError;
  const accountEmail = authSession?.email ?? "Signed-in account";

  return <div className="min-h-dvh bg-canvas text-ink"><a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-ink focus:px-4 focus:py-3 focus:text-sm focus:text-white">Skip to session</a><div className="flex min-h-dvh">
    <SessionSidebar sessions={sessions} activeSessionId={activeSessionId} onSessionSelect={handleSessionSelect} onNewSession={handleNewSession} accountEmail={accountEmail} environmentLabel={demoEnvironmentLabel} isLoading={isLoadingSessions} isNewSessionDisabled={isLoadingSessions || isCreatingSession} errorMessage={sessionListError} />
    <main className="flex min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}><div className="flex h-14 shrink-0 items-center border-b border-line bg-surface px-4 lg:hidden"><button type="button" onClick={() => setIsMobileNavVisible(true)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-mutedInk" aria-label="Open session history"><Menu size={18} /></button><span className="ml-2.5 text-sm font-bold tracking-[-0.02em]">opspilot</span></div>
      <SessionHeader title={activeSession?.title ?? "New session"} subtitle={isProcessing ? activeState?.compaction.status === "running" ? "Optimizing context" : activeState?.isThinking ? "Thinking" : "Processing request" : activeSession ? "Ready" : "Create a Session to begin"} agentName={demoAgentName} statusLabel={isProcessing ? "Processing" : "Ready"} onToggleContext={() => setIsContextVisible((value) => !value)} isContextVisible={isContextVisible} />
      <div className="flex min-h-0 flex-1"><section className="flex min-w-0 flex-1 flex-col"><div className="flex-1 overflow-y-auto scroll-smooth"><div className="mx-auto w-full max-w-[920px] px-4 pb-8 pt-6 sm:px-8 sm:pt-8"><div className="mb-7 flex items-center justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedInk">Session</p><p className="mt-1 text-xs text-mutedInk">{activeSession ? formatSessionUpdatedAt(activeSession.updatedAt) : "No active session"}</p></div></div>{visibleError && <div role="alert" className="mb-6 flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/[0.06] px-3.5 py-3 text-sm text-danger"><AlertCircle size={17} className="mt-0.5 shrink-0" /><p>{visibleError}</p></div>}<SessionThread items={timeline} agentName={demoAgentName} /></div></div><Composer disabled={!activeSessionId || loadingSessionIds[activeSessionId ?? ""] === true} draft={draft} attachments={attachments} isProcessing={isProcessing} agentName={demoAgentName} onDraftChange={setDraft} onSubmit={handleSubmit} onAttach={handleAttach} onRemoveAttachment={handleRemoveAttachment} /></section><ContextPanel status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} /></div>
    </main></div><div className="sr-only" aria-live="polite" aria-atomic="true">{(activeSessionId && statusBySessionId[activeSessionId]) ?? pageStatus}</div>
    {isMobileNavVisible && <div className="fixed inset-0 z-40 bg-navy/30 lg:hidden" onClick={() => setIsMobileNavVisible(false)}><div className="h-full w-[min(85vw,300px)]" role="dialog" aria-modal="true" aria-label="Session history" onClick={(event) => event.stopPropagation()}><div className="flex h-full flex-col bg-navy"><div className="flex items-center justify-between border-b border-white/10 px-5 py-3"><span className="text-sm font-bold text-white">Session history</span><button type="button" onClick={() => setIsMobileNavVisible(false)} className="flex h-9 w-9 items-center justify-center text-navy-muted" aria-label="Close session history"><X size={17} /></button></div><div className="min-h-0 flex-1"><SessionSidebar mobile sessions={sessions} activeSessionId={activeSessionId} onSessionSelect={handleSessionSelect} onNewSession={handleNewSession} accountEmail={accountEmail} environmentLabel={demoEnvironmentLabel} isLoading={isLoadingSessions} isNewSessionDisabled={isLoadingSessions || isCreatingSession} errorMessage={sessionListError} /></div></div></div></div>}
    {isContextVisible && <div className="fixed inset-0 z-30 bg-navy/20 xl:hidden" onClick={() => setIsContextVisible(false)}><div className="ml-auto h-full max-w-[360px]" onClick={(event) => event.stopPropagation()}><ContextPanel isMobile status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} onClose={() => setIsContextVisible(false)} /></div></div>}
  </div>;
}
