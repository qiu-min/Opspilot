import { useCallback, useEffect, useState } from "react";
import { getSessionTurnTrace } from "../../api/sessions/session-api";
import type { TurnTraceResponse } from "../../api/sessions/turn-trace-contracts";

export type UseTurnTraceResult = {
  trace: TurnTraceResponse | null;
  isLoading: boolean;
  error: unknown | null;
  refresh: () => void;
};

type UnauthorizedHandler = (error: unknown) => boolean;

export const TRACE_REFRESH_INTERVAL_MS = 1_500;

export type TurnTraceLoader = (signal: AbortSignal) => Promise<TurnTraceResponse>;

/** Refreshes a selected Trace serially until it reaches a terminal state or is aborted. */
export async function pollTurnTrace(
  loadTrace: TurnTraceLoader,
  signal: AbortSignal,
  onTrace: (trace: TurnTraceResponse) => void,
): Promise<void> {
  while (!signal.aborted) {
    let nextTrace: TurnTraceResponse;
    try {
      nextTrace = await loadTrace(signal);
    } catch (error: unknown) {
      if (signal.aborted) return;
      throw error;
    }

    if (signal.aborted) return;
    onTrace(nextTrace);
    if (nextTrace.status !== "running") return;
    if (!(await waitForNextPoll(signal, TRACE_REFRESH_INTERVAL_MS))) return;
  }
}

/** Loads one durable Trace and refreshes it while the selected Turn is running. */
export function useTurnTrace(
  sessionId: string | null,
  turnId: string | null,
  accessToken: string | undefined,
  onUnauthorized?: UnauthorizedHandler,
): UseTurnTraceResult {
  const [trace, setTrace] = useState<TurnTraceResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  const refresh = useCallback(() => {
    setRefreshVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    if (sessionId === null || turnId === null || accessToken === undefined) {
      setTrace(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let disposed = false;
    const traceSessionId = sessionId;
    const traceTurnId = turnId;
    const traceAccessToken = accessToken;
    setTrace(null);
    setIsLoading(true);
    setError(null);

    let isFirstRequest = true;
    void pollTurnTrace(
      (signal) => getSessionTurnTrace(traceSessionId, traceTurnId, traceAccessToken, signal),
      controller.signal,
      (nextTrace) => {
        if (disposed || controller.signal.aborted) return;
        setTrace(nextTrace);
        setError(null);
        if (isFirstRequest) {
          setIsLoading(false);
          isFirstRequest = false;
        }
      },
    ).catch((nextError: unknown) => {
      if (disposed || controller.signal.aborted) return;
      if (onUnauthorized?.(nextError)) return;

      setError(nextError);
      setIsLoading(false);
    });

    return () => {
      disposed = true;
      controller.abort();
    };
  }, [accessToken, onUnauthorized, refreshVersion, sessionId, turnId]);

  return { trace, isLoading, error, refresh };
}

function waitForNextPoll(signal: AbortSignal, delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    const timeoutId = globalThis.setTimeout(() => {
      cleanup();
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId);
      cleanup();
      resolve(false);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
