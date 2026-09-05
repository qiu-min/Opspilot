import { AlertCircle, Menu, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client";
import {
  createConversation,
  getConversation,
  listConversations,
  streamConversationTurn,
} from "../../api/conversations/conversations-api";
import { ConversationStreamProtocolError } from "../../api/conversations/conversation-stream-contracts";
import { getFileKind, getFileSize } from "../../lib/files";
import { demoAgentName, demoConnectedTools, demoContextFiles, demoContextStatus, demoEnvironmentLabel, demoRecentOutputs } from "./demo";
import { formatMessageCreatedAt, toConversationItems, toConversationSummary } from "./conversation-mappers";
import {
  ConversationStreamStateError,
  createInitialConversationStreamState,
  reduceConversationStreamEvent,
  type ConversationStreamState,
} from "./conversation-stream-state";
import type { Attachment, ChatMessage, ConversationItem, ConversationSummary } from "./types";
import { useAuth } from "../auth/auth-provider";
import { Composer, type ComposerSubmitPayload } from "./components/composer";
import { ContextPanel } from "./components/context-panel";
import { ConversationHeader } from "./components/conversation-header";
import { ConversationThread } from "./components/conversation-thread";
import { ConversationSidebar } from "./conversation-sidebar";

let temporaryMessageSequence = 0;

function createTemporaryMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `message-${crypto.randomUUID()}`;
  }

  temporaryMessageSequence += 1;
  return `message-${temporaryMessageSequence}`;
}

function formatConversationUpdatedAt(updatedAt: string) {
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return "Recently updated";

  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function getConversationErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ApiError) {
    return error.detail || error.title || fallback;
  }

  if (error instanceof TypeError) {
    return "Unable to reach OpsPilot. Check your connection and try again.";
  }

  return fallback;
}

function getConversationStreamErrorMessage(error: unknown) {
  if (error instanceof ConversationStreamProtocolError || error instanceof ConversationStreamStateError) {
    return "The response stream ended unexpectedly. Try again.";
  }

  return getConversationErrorMessage(error, "The request failed. Try sending it again.");
}

export function ConversationPage() {
  const { session } = useAuth();
  const accessToken = session?.accessToken;
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [timelinesByConversationId, setTimelinesByConversationId] = useState<Record<string, ConversationItem[]>>({});
  const [streamStatesByConversationId, setStreamStatesByConversationId] = useState<Record<string, ConversationStreamState | undefined>>({});
  const [attachmentsByConversationId, setAttachmentsByConversationId] = useState<Record<string, Attachment[]>>({});
  const [draft, setDraft] = useState("");
  const [isExecutionExpanded, setIsExecutionExpanded] = useState(false);
  const [isContextVisible, setIsContextVisible] = useState(false);
  const [isMobileNavVisible, setIsMobileNavVisible] = useState(false);
  const [pageStatusMessage, setPageStatusMessage] = useState("Ready");
  const [statusMessagesByConversationId, setStatusMessagesByConversationId] = useState<Record<string, string | undefined>>({});
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [isCreatingConversation, setIsCreatingConversation] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [conversationListError, setConversationListError] = useState<string | null>(null);
  const [errorsByConversationId, setErrorsByConversationId] = useState<Record<string, string | undefined>>({});
  const [historyLoadingByConversationId, setHistoryLoadingByConversationId] = useState<Record<string, boolean>>({});
  const [processingConversationIds, setProcessingConversationIds] = useState<Set<string>>(new Set());

  const listAbortControllerRef = useRef<AbortController | null>(null);
  const createAbortControllerRef = useRef<AbortController | null>(null);
  const historyAbortControllerRef = useRef<AbortController | null>(null);
  const turnAbortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const processingConversationIdsRef = useRef<Set<string>>(new Set());
  const historyLoadingByConversationIdRef = useRef<Record<string, boolean>>({});

  const setHistoryLoading = useCallback((conversationId: string, isLoading: boolean) => {
    historyLoadingByConversationIdRef.current = {
      ...historyLoadingByConversationIdRef.current,
      [conversationId]: isLoading,
    };
    setHistoryLoadingByConversationId((current) => ({
      ...current,
      [conversationId]: isLoading,
    }));
  }, []);

  const clearConversationStreamState = useCallback((conversationId: string) => {
    setStreamStatesByConversationId((current) => {
      if (!(conversationId in current)) return current;

      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  }, []);

  const setConversationStatus = useCallback((conversationId: string, message: string) => {
    setStatusMessagesByConversationId((current) => ({
      ...current,
      [conversationId]: message,
    }));
  }, []);

  const refreshConversations = useCallback(async (showLoading: boolean, failureMessage = "Unable to load conversations. Try again.") => {
    if (!accessToken) return false;

    listAbortControllerRef.current?.abort();
    const controller = new AbortController();
    listAbortControllerRef.current = controller;

    if (showLoading) {
      setIsLoadingConversations(true);
    }

    try {
      const responses = await listConversations(accessToken, controller.signal);
      if (controller.signal.aborted) return false;

      const nextConversations = responses.map(toConversationSummary);
      setConversations(nextConversations);
      setActiveConversationId((currentActiveConversationId) => {
        if (currentActiveConversationId && nextConversations.some((conversation) => conversation.id === currentActiveConversationId)) {
          return currentActiveConversationId;
        }

        return nextConversations[0]?.id ?? null;
      });
      setConversationListError(null);
      setPageError(null);
      return true;
    } catch (error: unknown) {
      if (controller.signal.aborted) return false;

      const message = getConversationErrorMessage(error, failureMessage);
      setConversationListError(message);
      setPageError(message);
      return false;
    } finally {
      if (listAbortControllerRef.current === controller) {
        listAbortControllerRef.current = null;
        if (showLoading) {
          setIsLoadingConversations(false);
        }
      }
    }
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) {
      setConversations([]);
      setActiveConversationId(null);
      return;
    }

    void refreshConversations(true);

    return () => {
      listAbortControllerRef.current?.abort();
    };
  }, [accessToken, refreshConversations]);

  useEffect(() => {
    historyAbortControllerRef.current?.abort();

    if (!accessToken || !activeConversationId) {
      return;
    }

    const conversationId = activeConversationId;
    const controller = new AbortController();
    historyAbortControllerRef.current = controller;
    setHistoryLoading(conversationId, true);
    setErrorsByConversationId((current) => {
      if (!(conversationId in current)) return current;

      const next = { ...current };
      delete next[conversationId];
      return next;
    });

    void getConversation(conversationId, accessToken, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (processingConversationIdsRef.current.has(conversationId)) return;

        const items = toConversationItems(response);
        setTimelinesByConversationId((current) => ({
          ...current,
          [conversationId]: items,
        }));
        clearConversationStreamState(conversationId);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;

        setErrorsByConversationId((current) => ({
          ...current,
          [conversationId]: getConversationErrorMessage(
            error,
            "Unable to load this conversation. Try selecting it again.",
          ),
        }));
      })
      .finally(() => {
        if (historyAbortControllerRef.current !== controller) return;

        historyAbortControllerRef.current = null;
        setHistoryLoading(conversationId, false);
      });

    return () => {
      controller.abort();
      if (historyLoadingByConversationIdRef.current[conversationId] === true) {
        setHistoryLoading(conversationId, false);
      }
      if (historyAbortControllerRef.current === controller) {
        historyAbortControllerRef.current = null;
      }
    };
  }, [accessToken, activeConversationId, clearConversationStreamState, setHistoryLoading]);

  useEffect(() => {
    return () => {
      listAbortControllerRef.current?.abort();
      createAbortControllerRef.current?.abort();
      historyAbortControllerRef.current?.abort();
      for (const controller of turnAbortControllersRef.current.values()) {
        controller.abort();
      }
    };
  }, []);

  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
  const timeline = activeConversation ? timelinesByConversationId[activeConversation.id] ?? [] : [];
  const attachments = activeConversation ? attachmentsByConversationId[activeConversation.id] ?? [] : [];
  const isProcessing = activeConversationId !== null && processingConversationIds.has(activeConversationId);
  const activeStreamState = activeConversationId
    ? streamStatesByConversationId[activeConversationId]
    : undefined;
  const activeConversationStatus = activeConversationId
    ? statusMessagesByConversationId[activeConversationId]
    : undefined;
  const liveStatusMessage = activeConversationStatus ?? pageStatusMessage;
  const conversationError = activeConversationId ? errorsByConversationId[activeConversationId] : undefined;
  const visibleError = conversationError ?? pageError;
  const accountEmail = session?.email ?? "Signed-in account";
  const statusLabel = isProcessing ? "Processing" : "Ready";
  const isLoadingHistory = activeConversationId !== null && historyLoadingByConversationId[activeConversationId] === true;
  const conversationSubtitle = activeConversation
    ? isProcessing
      ? activeStreamState?.compaction.status === "running"
        ? "Optimizing context"
        : activeStreamState?.isThinking
          ? "Thinking"
          : "Processing request"
      : isLoadingHistory
        ? "Loading history"
        : "Ready"
    : "Create a conversation to begin";

  async function handleNewConversation() {
    if (!accessToken || isCreatingConversation) return;

    listAbortControllerRef.current?.abort();
    setPageError(null);
    setIsCreatingConversation(true);
    createAbortControllerRef.current?.abort();
    const controller = new AbortController();
    createAbortControllerRef.current = controller;

    try {
      const response = await createConversation(accessToken, controller.signal);
      if (controller.signal.aborted) return;

      const newConversation = toConversationSummary(response);
      setConversations((current) => [newConversation, ...current.filter((conversation) => conversation.id !== newConversation.id)]);
      setActiveConversationId(newConversation.id);
      setTimelinesByConversationId((current) => ({ ...current, [newConversation.id]: [] }));
      setAttachmentsByConversationId((current) => ({ ...current, [newConversation.id]: [] }));
      setDraft("");
      setIsExecutionExpanded(false);
      setIsMobileNavVisible(false);
      setConversationListError(null);
      setPageStatusMessage("New conversation ready");
    } catch (error: unknown) {
      if (controller.signal.aborted) return;

      setPageError(getConversationErrorMessage(error, "Unable to create a conversation. Try again."));
      setPageStatusMessage("Conversation creation failed");
    } finally {
      if (createAbortControllerRef.current === controller) {
        createAbortControllerRef.current = null;
      }
      if (!controller.signal.aborted) {
        setIsCreatingConversation(false);
      }
    }
  }

  function handleConversationSelect(conversationId: string) {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (!conversation) return;

    setActiveConversationId(conversationId);
    setDraft("");
    setIsExecutionExpanded(false);
    setIsMobileNavVisible(false);
    setPageStatusMessage(`Selected ${conversation.title}`);
  }

  async function handleSubmit({ body, attachments: submittedAttachments }: ComposerSubmitPayload) {
    const conversationId = activeConversationId;
    const token = accessToken;
    if (!conversationId || !token || historyLoadingByConversationIdRef.current[conversationId] === true) return;

    if (submittedAttachments.length > 0) {
      const message = "File attachments are not connected yet. Remove the attachment before sending.";
      setErrorsByConversationId((current) => ({ ...current, [conversationId]: message }));
      setConversationStatus(conversationId, "Attachment sending is unavailable");
      return;
    }

    if (processingConversationIdsRef.current.has(conversationId)) return;

    processingConversationIdsRef.current.add(conversationId);
    setProcessingConversationIds(new Set(processingConversationIdsRef.current));
    setErrorsByConversationId((current) => {
      if (!(conversationId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[conversationId];
      return next;
    });

    const userMessage: ChatMessage = {
      id: createTemporaryMessageId(),
      role: "user",
      body,
      createdAt: formatMessageCreatedAt(),
    };

    setTimelinesByConversationId((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] ?? []), { type: "message", id: userMessage.id, message: userMessage }],
    }));
    setDraft("");
    setConversationStatus(conversationId, "Processing your request");

    const controller = new AbortController();
    turnAbortControllersRef.current.set(conversationId, controller);
    let streamState = createInitialConversationStreamState();
    let responseStarted = false;

    setStreamStatesByConversationId((current) => ({
      ...current,
      [conversationId]: streamState,
    }));

    const removeOptimisticUserMessage = () => {
      setTimelinesByConversationId((current) => ({
        ...current,
        [conversationId]: (current[conversationId] ?? []).filter(
          (item) => item.id !== userMessage.id,
        ),
      }));
    };

    const publishStreamState = (nextState: ConversationStreamState) => {
      setStreamStatesByConversationId((current) => ({
        ...current,
        [conversationId]: nextState,
      }));
    };

    try {
      for await (const event of streamConversationTurn(
        conversationId,
        { message: body, fileId: null },
        token,
        controller.signal,
      )) {
        streamState = reduceConversationStreamEvent(streamState, event);
        publishStreamState(streamState);

        if (event.type === "response_started") {
          responseStarted = true;
          setConversationStatus(conversationId, "Assistant response started");
        } else if (event.type === "assistant_thinking_started") {
          setConversationStatus(conversationId, "Assistant is thinking");
        } else if (event.type === "assistant_thinking_completed") {
          setConversationStatus(conversationId, "Assistant is responding");
        } else if (event.type === "tool_execution_started") {
          setConversationStatus(conversationId, `Running ${event.name}`);
        } else if (event.type === "tool_execution_completed") {
          setConversationStatus(conversationId, event.isError ? `${event.name} failed` : `${event.name} completed`);
        } else if (event.type === "context_compaction_started") {
          setConversationStatus(conversationId, "Optimizing context");
        } else if (event.type === "context_compaction_completed") {
          setConversationStatus(conversationId, "Assistant is responding");
        } else if (event.type === "response_completed") {
          setConversationStatus(
            conversationId,
            event.status === "completed"
              ? "Response completed"
              : event.status === "aborted"
                ? "Response stopped"
                : "Response failed",
          );

          try {
            const response = await getConversation(
              conversationId,
              token,
              controller.signal,
            );
            if (controller.signal.aborted) return;

            setTimelinesByConversationId((current) => ({
              ...current,
              [conversationId]: toConversationItems(response),
            }));
            clearConversationStreamState(conversationId);
            setErrorsByConversationId((current) => {
              const next = { ...current };
              if (event.status === "completed") {
                delete next[conversationId];
              } else {
                next[conversationId] =
                  event.status === "aborted"
                    ? "Response stopped."
                    : "The response failed. Try again.";
              }
              return next;
            });
            void refreshConversations(
              false,
              "Response completed, but the conversation list could not be refreshed.",
            );
          } catch (historyError: unknown) {
            if (controller.signal.aborted) return;

            setErrorsByConversationId((current) => ({
              ...current,
              [conversationId]: "Response completed, but conversation history could not be refreshed.",
            }));
            setConversationStatus(conversationId, "Response completed, but history could not be refreshed");
            void refreshConversations(
              false,
              "Response completed, but the conversation list could not be refreshed.",
            );
          }
          break;
        } else if (event.type === "error") {
          setErrorsByConversationId((current) => ({
            ...current,
            [conversationId]: "The response failed. Try again.",
          }));
          setConversationStatus(conversationId, "Response failed. You can try again.");
          break;
        }
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        if (!responseStarted) {
          removeOptimisticUserMessage();
          clearConversationStreamState(conversationId);
        }
        return;
      }

      const message = getConversationStreamErrorMessage(error);
      if (!responseStarted) {
        removeOptimisticUserMessage();
        clearConversationStreamState(conversationId);
      } else {
        if (streamState.phase === "streaming") {
          streamState = reduceConversationStreamEvent(streamState, {
            type: "error",
            message,
          });
          publishStreamState(streamState);
        }
      }

      setErrorsByConversationId((current) => ({ ...current, [conversationId]: message }));
      setConversationStatus(conversationId, "Request failed. You can try again.");
    } finally {
      turnAbortControllersRef.current.delete(conversationId);
      processingConversationIdsRef.current.delete(conversationId);
      setProcessingConversationIds(new Set(processingConversationIdsRef.current));
    }
  }

  function handleAttach(files: FileList) {
    if (!activeConversationId) return;
    const conversationId = activeConversationId;

    const nextFiles = Array.from(files).map((file, index): Attachment => ({
      id: `${file.name}-${file.lastModified}-${index}`,
      name: file.name,
      size: getFileSize(file.size),
      kind: getFileKind(file.name),
    }));

    setAttachmentsByConversationId((current) => ({
      ...current,
      [conversationId]: [...(current[conversationId] ?? []), ...nextFiles],
    }));
    setErrorsByConversationId((current) => {
      if (!(conversationId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[conversationId];
      return next;
    });
    setConversationStatus(conversationId, `${nextFiles.length} file${nextFiles.length === 1 ? "" : "s"} attached`);
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
        <ConversationSidebar
          conversations={conversations}
          activeConversationId={activeConversationId}
          onConversationSelect={handleConversationSelect}
          onNewConversation={handleNewConversation}
          accountEmail={accountEmail}
          environmentLabel={demoEnvironmentLabel}
          isLoading={isLoadingConversations}
          isNewConversationDisabled={isLoadingConversations || isCreatingConversation}
          errorMessage={conversationListError}
        />

        <main className="flex min-w-0 flex-1 flex-col" id="main-content" tabIndex={-1}>
          <div className="flex h-14 shrink-0 items-center border-b border-line bg-surface px-4 lg:hidden">
            <button type="button" onClick={() => setIsMobileNavVisible(true)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-mutedInk transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60" aria-label="Open conversation history"><Menu size={18} aria-hidden="true" /></button>
            <span className="ml-2.5 text-sm font-bold tracking-[-0.02em]">opspilot</span>
          </div>

          <ConversationHeader
            title={activeConversation?.title ?? "New conversation"}
            subtitle={conversationSubtitle}
            agentName={demoAgentName}
            statusLabel={statusLabel}
            onToggleContext={() => setIsContextVisible((visible) => !visible)}
            isContextVisible={isContextVisible}
          />

          <div className="flex min-h-0 flex-1">
            <section className="flex min-w-0 flex-1 flex-col" aria-label="Conversation thread">
              <div className="flex-1 overflow-y-auto scroll-smooth">
                <div className="mx-auto w-full max-w-[920px] px-4 pb-8 pt-6 sm:px-8 sm:pt-8">
                  <div className="mb-7 flex items-center justify-between gap-4"><div><p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-mutedInk">Conversation</p><p className="mt-1 text-xs text-mutedInk">{activeConversation ? formatConversationUpdatedAt(activeConversation.updatedAt) : "No active conversation"}</p></div></div>
                  {visibleError && <div role="alert" className="mb-6 flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/[0.06] px-3.5 py-3 text-sm text-danger"><AlertCircle size={17} className="mt-0.5 shrink-0" aria-hidden="true" /><p>{visibleError}</p></div>}
                  <ConversationThread
                    conversationId={activeConversation?.id ?? "new"}
                    items={timeline}
                    agentName={demoAgentName}
                    isExecutionExpanded={isExecutionExpanded}
                    onToggleExecution={() => setIsExecutionExpanded((expanded) => !expanded)}
                    streamState={activeStreamState}
                  />
                </div>
              </div>
              <Composer disabled={!activeConversationId || isLoadingHistory} draft={draft} attachments={attachments} isProcessing={isProcessing} agentName={demoAgentName} onDraftChange={setDraft} onSubmit={handleSubmit} onAttach={handleAttach} onRemoveAttachment={handleRemoveAttachment} />
            </section>
            <ContextPanel status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} />
          </div>
        </main>
      </div>

      <div className="sr-only" aria-live="polite" aria-atomic="true">{liveStatusMessage}</div>

      {isMobileNavVisible && (
        <div className="fixed inset-0 z-40 bg-navy/30 lg:hidden" onClick={() => setIsMobileNavVisible(false)}>
          <div className="h-full w-[min(85vw,300px)]" role="dialog" aria-modal="true" aria-label="Conversation history" onClick={(event) => event.stopPropagation()}>
            <div className="flex h-full flex-col bg-navy"><div className="flex items-center justify-between border-b border-white/10 px-5 py-3"><span className="text-sm font-bold text-white">Conversation history</span><button type="button" onClick={() => setIsMobileNavVisible(false)} className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg text-navy-muted hover:bg-white/[0.1] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label="Close conversation history"><X size={17} aria-hidden="true" /></button></div><div className="min-h-0 flex-1"><ConversationSidebar mobile conversations={conversations} activeConversationId={activeConversationId} onConversationSelect={handleConversationSelect} onNewConversation={handleNewConversation} accountEmail={accountEmail} environmentLabel={demoEnvironmentLabel} isLoading={isLoadingConversations} isNewConversationDisabled={isLoadingConversations || isCreatingConversation} errorMessage={conversationListError} /></div></div>
          </div>
        </div>
      )}

      {isContextVisible && <div className="fixed inset-0 z-30 bg-navy/20 xl:hidden" onClick={() => setIsContextVisible(false)}><div className="ml-auto h-full max-w-[360px]" onClick={(event) => event.stopPropagation()}><ContextPanel isMobile status={demoContextStatus} files={demoContextFiles} tools={demoConnectedTools} outputs={demoRecentOutputs} onClose={() => setIsContextVisible(false)} /></div></div>}
    </div>
  );
}
