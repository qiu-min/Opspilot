import { AlertCircle, Menu, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { createSession, getActiveSessionTurn, getSession, listSessions, reattachSessionTurnStream, startSessionTurnStream } from "../../api/sessions/session-api";
import type { ActiveTurnResponse } from "../../api/sessions/session-contracts";
import type { TurnStreamEvent } from "../../api/sessions/turn-stream-contracts";
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
import { classifyTurnStreamError, isSessionTurnProcessing, planActiveTurnRecovery, removeOptimisticMessage, shouldHydrateTurnProjection, shouldStartTurnSubscription } from "./turn-recovery";
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
  const activeTurnIdsRef = useRef<Record<string, string | undefined>>({});
  const [turnStreamStatesByTurnId, setTurnStreamStatesByTurnId] = useState<Record<string, TurnStreamState | undefined>>({});
  const turnStreamStatesRef = useRef<Record<string, TurnStreamState | undefined>>({});
  const turnStreamControllersByTurnId = useRef(new Map<string, AbortController>());
  const pendingStartControllersBySessionId = useRef(new Map<string, AbortController>());
  const [attachmentsBySessionId, setAttachmentsBySessionId] = useState<Record<string, PendingAttachment[]>>({});
  const [pendingTurnStartSessionIds, setPendingTurnStartSessionIds] = useState<Set<string>>(new Set());
  const pendingTurnStartSessionIdsRef = useRef(new Set<string>());
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
  const setActiveTurnId = useCallback((sessionId: string, turnId: string | undefined) => {
    activeTurnIdsRef.current = { ...activeTurnIdsRef.current, [sessionId]: turnId };
    setActiveTurnIdBySessionId((current) => ({ ...current, [sessionId]: turnId }));
  }, []);
  const setPendingTurnStart = useCallback((sessionId: string, pending: boolean) => {
    if (pending) pendingTurnStartSessionIdsRef.current.add(sessionId);
    else pendingTurnStartSessionIdsRef.current.delete(sessionId);
    setPendingTurnStartSessionIds(new Set(pendingTurnStartSessionIdsRef.current));
  }, []);
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
      const hydrated = hydrateActiveTurnProjection(sessionId, active);
      if (hydrated !== undefined) {
        startTurnSubscription(
          sessionId,
          hydrated.turnId,
          (signal) => reattachSessionTurnStream(sessionId, hydrated.turnId, hydrated.afterSequence, accessToken, signal),
          true,
        );
      }
    } catch (error: unknown) { if (!controller.signal.aborted) setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "Unable to load this session. Try selecting it again.") })); }
    finally { if (sessionController.current === controller) { sessionController.current = null; setLoadingSessionIds((current) => ({ ...current, [sessionId]: false })); } }
  }, [accessToken]);

  useEffect(() => { if (activeSessionId) void loadSession(activeSessionId); return () => sessionController.current?.abort(); }, [activeSessionId, loadSession]);

  function hydrateActiveTurnProjection(sessionId: string, active: ActiveTurnResponse, expectedTurnId?: string): { turnId: string; afterSequence: number } | undefined {
    if (active.activeTurn === null) {
      setActiveTurnId(sessionId, undefined);
      setPendingTurnStart(sessionId, false);
      return undefined;
    }
    const { turnId, projection } = active.activeTurn;
    if (expectedTurnId !== undefined && expectedTurnId !== turnId) {
      throw new TurnStreamStateError("Active Turn identity changed during recovery.");
    }
    setActiveTurnId(sessionId, turnId);
    setPendingTurnStart(sessionId, false);
    const local = turnStreamStatesRef.current[turnId];
    if (shouldHydrateTurnProjection(local?.lastSequence, projection.lastSequence)) {
      setTurnState(turnId, hydrateTurnStreamStateFromProjection(projection));
    }
    return { turnId, afterSequence: projection.lastSequence };
  }

  function startTurnSubscription(
    sessionId: string,
    expectedTurnId: string | undefined,
    openStream: (signal: AbortSignal) => AsyncGenerator<TurnStreamEvent>,
    allowRecovery: boolean,
    optimisticMessageId?: string,
  ) {
    if (expectedTurnId !== undefined) {
      if (pendingStartControllersBySessionId.current.has(sessionId)) return;
      if (!shouldStartTurnSubscription(turnStreamControllersByTurnId.current.has(expectedTurnId))) return;
    } else if (pendingStartControllersBySessionId.current.has(sessionId)) {
      return;
    }

    const controller = new AbortController();
    if (expectedTurnId === undefined) pendingStartControllersBySessionId.current.set(sessionId, controller);
    else turnStreamControllersByTurnId.current.set(expectedTurnId, controller);

    let stream: AsyncGenerator<TurnStreamEvent>;
    try {
      stream = openStream(controller.signal);
    } catch (error: unknown) {
      releaseTurnStreamController(sessionId, expectedTurnId, controller);
      handleSubscriptionFailure(sessionId, error, optimisticMessageId);
      return;
    }

    void consumeTurnStream(sessionId, expectedTurnId, stream, controller, allowRecovery, optimisticMessageId).catch((error: unknown) => {
      releaseTurnStreamController(sessionId, expectedTurnId, controller);
      handleSubscriptionFailure(sessionId, error, optimisticMessageId);
    });
  }

  async function consumeTurnStream(sessionId: string, expectedTurnId: string | undefined, stream: AsyncGenerator<TurnStreamEvent>, controller: AbortController, allowRecovery: boolean, optimisticMessageId?: string) {
    let turnId = expectedTurnId; let terminal = false;
    try {
      for await (const event of stream) {
        if (turnId !== undefined && event.turnId !== turnId) throw new TurnStreamStateError("Turn stream changed Turn identity.");
        turnId ??= event.turnId;
        const existingController = turnStreamControllersByTurnId.current.get(turnId);
        if (existingController !== undefined && existingController !== controller) throw new TurnStreamStateError("A second subscriber attempted to own the same Turn.");
        turnStreamControllersByTurnId.current.set(turnId, controller);
        setActiveTurnId(sessionId, turnId);
        setPendingTurnStart(sessionId, false);
        const current = turnStreamStatesRef.current[turnId] ?? createInitialTurnStreamState(turnId, sessionId);
        const next = reduceTurnStreamEvent(current, event); setTurnState(turnId, next);
        if (event.type === "turn_started") setSessionStatus(sessionId, "Processing your request");
        if (event.type === "assistant_thinking_started") setSessionStatus(sessionId, "Assistant is thinking");
        if (event.type === "assistant_text_delta") setSessionStatus(sessionId, "Assistant is responding");
        if (event.type === "tool_started") setSessionStatus(sessionId, `Running ${event.name}`);
        if (event.type === "tool_completed") setSessionStatus(sessionId, event.isError ? `${event.name} failed` : `${event.name} completed`);
        if (event.type === "turn_completed" || event.type === "turn_failed" || event.type === "turn_cancelled") { terminal = true; await reconcileTerminalSession(sessionId, turnId); break; }
      }
      if (!terminal && !controller.signal.aborted) {
        releaseTurnStreamController(sessionId, turnId, controller);
        if (allowRecovery) {
          await recoverDisconnectedTurn(sessionId, turnId, optimisticMessageId);
        } else {
          await reconcileEndedTurnStream(sessionId, turnId);
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const conflictKind = classifyTurnStreamError(error);
      if (conflictKind === "session_active_turn") {
        rollbackOptimisticMessage(sessionId, optimisticMessageId);
        releaseTurnStreamController(sessionId, turnId, controller);
        await recoverDisconnectedTurn(sessionId, turnId);
        return;
      }
      if (conflictKind === "replay_gap" && allowRecovery) {
        releaseTurnStreamController(sessionId, turnId, controller);
        await recoverDisconnectedTurn(sessionId, turnId, optimisticMessageId);
        return;
      }
      if (conflictKind === "other_conflict") {
        rollbackOptimisticMessage(sessionId, optimisticMessageId);
        setPendingTurnStart(sessionId, false);
        setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "The request conflicts with an active Turn.") }));
        return;
      }
      if (optimisticMessageId !== undefined && error instanceof ApiError) {
        rollbackOptimisticMessage(sessionId, optimisticMessageId);
        setPendingTurnStart(sessionId, false);
        setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "The request failed. Try again.") }));
        return;
      }
      if (allowRecovery) {
        releaseTurnStreamController(sessionId, turnId, controller);
        await recoverDisconnectedTurn(sessionId, turnId, optimisticMessageId);
        return;
      }
      setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "The live stream could not be restored.") }));
    } finally { releaseTurnStreamController(sessionId, turnId, controller); }
  }

  async function recoverDisconnectedTurn(sessionId: string, expectedTurnId?: string, optimisticMessageId?: string) {
    if (!accessToken) return;
    try {
      const active = await getActiveSessionTurn(sessionId, accessToken);
      const recoveryPlan = planActiveTurnRecovery(active, expectedTurnId);
      if (recoveryPlan.kind === "reload_history") {
        clearTurnState(expectedTurnId);
        await loadSession(sessionId);
        return;
      }
      hydrateActiveTurnProjection(sessionId, active, expectedTurnId);
      startTurnSubscription(
        sessionId,
        recoveryPlan.turnId,
        (signal) => reattachSessionTurnStream(sessionId, recoveryPlan.turnId, recoveryPlan.afterSequence, accessToken, signal),
        false,
        optimisticMessageId,
      );
    } catch (error: unknown) {
      setPendingTurnStart(sessionId, false);
      setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "Unable to reattach the active Turn.") }));
    }
  }

  async function reconcileEndedTurnStream(sessionId: string, turnId: string | undefined) {
    if (!accessToken) return;
    try {
      const active = await getActiveSessionTurn(sessionId, accessToken);
      if (active.activeTurn !== null) {
        setErrorsBySessionId((current) => ({ ...current, [sessionId]: "The live stream ended before the Turn reached a terminal state." }));
        return;
      }

      clearTurnState(turnId);
      await loadSession(sessionId);
    } catch (error: unknown) {
      setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "Unable to reconcile the completed Turn.") }));
    }
  }

  function releaseTurnStreamController(sessionId: string, turnId: string | undefined, controller: AbortController) {
    if (turnId !== undefined && turnStreamControllersByTurnId.current.get(turnId) === controller) turnStreamControllersByTurnId.current.delete(turnId);
    if (pendingStartControllersBySessionId.current.get(sessionId) === controller) pendingStartControllersBySessionId.current.delete(sessionId);
  }

  function clearTurnState(turnId: string | undefined) {
    if (turnId === undefined) return;
    turnStreamStatesRef.current = Object.fromEntries(Object.entries(turnStreamStatesRef.current).filter(([id]) => id !== turnId));
    setTurnStreamStatesByTurnId((current) => { const next = { ...current }; delete next[turnId]; return next; });
  }

  function rollbackOptimisticMessage(sessionId: string, messageId: string | undefined) {
    if (messageId === undefined) return;
    setTimelinesBySessionId((current) => ({
      ...current,
      [sessionId]: removeOptimisticMessage(current[sessionId] ?? [], messageId),
    }));
  }

  function handleSubscriptionFailure(sessionId: string, error: unknown, optimisticMessageId?: string) {
    rollbackOptimisticMessage(sessionId, optimisticMessageId);
    setPendingTurnStart(sessionId, false);
    setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "The live stream could not be restored.") }));
  }

  async function reconcileTerminalSession(sessionId: string, turnId: string) {
    if (!accessToken) return;
    try {
      const detail = await getSession(sessionId, accessToken);
      setTimelinesBySessionId((current) => ({ ...current, [sessionId]: toSessionItems(detail) }));
      await refreshSessions();
      setSessionStatus(sessionId, "Response completed");
    } catch (error: unknown) {
      setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "Unable to refresh the completed Session.") }));
    } finally {
      setActiveTurnId(sessionId, undefined);
      setPendingTurnStart(sessionId, false);
      clearTurnState(turnId);
    }
  }

  async function handleNewSession() {
    if (!accessToken || isCreatingSession) return; setIsCreatingSession(true);
    try { const created = toSessionSummary(await createSession(accessToken)); setSessions((current) => [created, ...current.filter((item) => item.id !== created.id)]); setActiveSessionId(created.id); setTimelinesBySessionId((current) => ({ ...current, [created.id]: [] })); setAttachmentsBySessionId((current) => ({ ...current, [created.id]: [] })); setPageStatus("New session ready"); setIsMobileNavVisible(false); }
    catch (error: unknown) { setPageError(errorMessage(error, "Unable to create a Session. Try again.")); }
    finally { setIsCreatingSession(false); }
  }

  async function handleSubmit({ body, attachments }: ComposerSubmitPayload) {
    const sessionId = activeSessionId; if (!sessionId || !accessToken || activeTurnIdsRef.current[sessionId] !== undefined || pendingTurnStartSessionIdsRef.current.has(sessionId)) return;
    if (!body.trim()) return;
    if (attachments.length > 1 || attachments.some((attachment) => !isXlsxFile(attachment.file))) { setErrorsBySessionId((current) => ({ ...current, [sessionId]: "Only one .xlsx file can be sent per message." })); return; }
    let optimisticId: string | undefined;
    try {
      const uploadController = new AbortController();
      const uploaded = await uploadPendingAttachment(attachments, accessToken, uploadController.signal, uploadFile); const message: ChatMessage = { id: temporaryMessageId(), role: "user", body: body.trim(), createdAt: formatMessageCreatedAt(), ...(uploaded.attachment === undefined ? {} : { attachments: [uploaded.attachment] }) }; optimisticId = message.id;
      setTimelinesBySessionId((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), { type: "message", id: message.id, message }] })); setDraft(""); setAttachmentsBySessionId((current) => ({ ...current, [sessionId]: [] })); setSessionStatus(sessionId, "Processing your request");
      setPendingTurnStart(sessionId, true);
      startTurnSubscription(
        sessionId,
        undefined,
        (signal) => startSessionTurnStream(sessionId, { message: body.trim(), fileId: uploaded.fileId }, accessToken, signal),
        true,
        optimisticId,
      );
    } catch (error: unknown) {
      rollbackOptimisticMessage(sessionId, optimisticId);
      setPendingTurnStart(sessionId, false);
      if (error instanceof SessionAttachmentValidationError) setErrorsBySessionId((current) => ({ ...current, [sessionId]: error.message }));
      else setErrorsBySessionId((current) => ({ ...current, [sessionId]: errorMessage(error, "The request failed. Try again.") }));
    }
  }

  function handleSessionSelect(sessionId: string) { if (!sessions.some((item) => item.id === sessionId)) return; setActiveSessionId(sessionId); setDraft(""); setIsMobileNavVisible(false); }
  function handleAttach(file: File) { if (!activeSessionId) return; setAttachmentsBySessionId((current) => ({ ...current, [activeSessionId]: replacePendingAttachment(file) })); }
  function handleRemoveAttachment(id: string) { if (!activeSessionId) return; setAttachmentsBySessionId((current) => ({ ...current, [activeSessionId]: (current[activeSessionId] ?? []).filter((item) => item.id !== id) })); }

  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? null;
  const durableTimeline = activeSessionId ? timelinesBySessionId[activeSessionId] ?? [] : [];
  const activeTurnId = activeSessionId ? activeTurnIdBySessionId[activeSessionId] : undefined;
  const activeState = activeTurnId ? turnStreamStatesByTurnId[activeTurnId] : undefined;
  const liveResponse = activeState ? projectTurnStream(activeState, `turn-${activeState.turnId}`) : undefined;
  const timeline = mergeLiveTurnResponse(durableTimeline, liveResponse, liveResponse?.id);
  const isProcessing = activeSessionId !== null && isSessionTurnProcessing(activeTurnId, pendingTurnStartSessionIds.has(activeSessionId));
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
