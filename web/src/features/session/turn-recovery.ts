import type { ActiveTurnResponse } from "../../api/sessions/session-contracts";
import type { SessionItem } from "./types";

export type TurnStreamConflictKind = "replay_gap" | "session_active_turn" | "other_conflict" | "other";
export type ActiveTurnRecoveryPlan =
  | { kind: "reload_history" }
  | { kind: "reattach"; turnId: string; afterSequence: number };

export function shouldHydrateTurnProjection(localSequence: number | undefined, projectionSequence: number): boolean {
  return localSequence === undefined || projectionSequence >= localSequence;
}

export function planActiveTurnRecovery(active: ActiveTurnResponse, expectedTurnId?: string): ActiveTurnRecoveryPlan {
  if (active.activeTurn === null) return { kind: "reload_history" };
  if (expectedTurnId !== undefined && expectedTurnId !== active.activeTurn.turnId) {
    throw new Error("Active Turn identity changed during recovery.");
  }
  return { kind: "reattach", turnId: active.activeTurn.turnId, afterSequence: active.activeTurn.projection.lastSequence };
}

export function classifyTurnStreamError(error: unknown): TurnStreamConflictKind {
  if (typeof error !== "object" || error === null) return "other";
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  if (code === "TURN_STREAM_REPLAY_GAP") return "replay_gap";
  if (code === "SESSION_ACTIVE_TURN_CONFLICT") return "session_active_turn";
  if ("status" in error && error.status === 409) return "other_conflict";
  return "other";
}

export function isSessionTurnProcessing(activeTurnId: string | undefined, pendingStart: boolean): boolean {
  return activeTurnId !== undefined || pendingStart;
}

export function shouldClearTurnAfterFailure(
  activeTurnId: string | undefined,
  failedTurnId: string | undefined,
): boolean {
  return failedTurnId === undefined || activeTurnId === failedTurnId;
}

export function shouldStartTurnSubscription(hasExistingSubscription: boolean): boolean {
  return !hasExistingSubscription;
}

export function removeOptimisticMessage(items: SessionItem[], messageId: string): SessionItem[] {
  return items.filter((item) => !(item.type === "message" && item.id === messageId));
}
