import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import type { ActiveTurnResponse } from "../../api/sessions/session-contracts";
import { hydrateTurnStreamStateFromProjection, reduceTurnStreamEvent } from "./turn-stream-state";
import { classifyTurnStreamError, isSessionTurnProcessing, planActiveTurnRecovery, removeOptimisticMessage, shouldClearTurnAfterFailure, shouldHydrateTurnProjection, shouldStartTurnSubscription } from "./turn-recovery";

const projection = (lastSequence: number, startedAt?: string) => ({
  turnId: "t1", sessionId: "s1", status: "running" as const,
  assistant: { text: "latest", messageVisible: true, isThinking: false }, tools: [],
  compaction: { status: "idle" as const }, usage: null, lastSequence,
  ...(startedAt === undefined ? {} : { startedAt }),
});
const active = (lastSequence: number): ActiveTurnResponse => ({ activeTurn: { turnId: "t1", sessionId: "s1", status: "running", projection: projection(lastSequence) } });

describe("turn recovery coordinator", () => {
  it("plans refresh recovery from the active projection sequence", () => {
    expect(planActiveTurnRecovery(active(7))).toEqual({ kind: "reattach", turnId: "t1", afterSequence: 7 });
    expect(isSessionTurnProcessing("t1", false)).toBe(true);
  });

  it("adopts an active Turn even when no turnId was observed before disconnect", () => {
    expect(planActiveTurnRecovery(active(3))).toEqual({ kind: "reattach", turnId: "t1", afterSequence: 3 });
  });

  it("rehydrates after a replay gap when the projection is newer", () => {
    expect(classifyTurnStreamError(new ApiError(409, "Conflict", "gap", "TURN_STREAM_REPLAY_GAP"))).toBe("replay_gap");
    expect(shouldHydrateTurnProjection({ lastSequence: 20, startedAt: "A" }, projection(137, "A"))).toBe(true);
  });

  it("does not let an older projection move live state backwards", () => {
    expect(shouldHydrateTurnProjection({ lastSequence: 100, startedAt: "A" }, projection(90, "A"))).toBe(false);
  });

  it("hydrates a new live epoch even when its sequence is smaller", () => {
    const serverProjection = projection(3, "B");
    expect(shouldHydrateTurnProjection({ lastSequence: 100, startedAt: "A" }, serverProjection)).toBe(true);

    let state = hydrateTurnStreamStateFromProjection(serverProjection);
    state = reduceTurnStreamEvent(state, {
      turnId: "t1",
      sessionId: "s1",
      type: "assistant_text_delta",
      delta: " resumed",
      sequence: 4,
      timestamp: "2026-09-09T00:00:04Z",
    });

    expect(state.lastSequence).toBe(4);
    expect(state.startedAt).toBe("B");
    expect(state.assistantMessages[0]?.text).toBe("latest resumed");
  });

  it("keeps sequence-only comparison for projections from the legacy contract", () => {
    expect(shouldHydrateTurnProjection({ lastSequence: 10 }, projection(11))).toBe(true);
    expect(shouldHydrateTurnProjection({ lastSequence: 10 }, projection(9))).toBe(false);
  });

  it("classifies active-session conflict and removes its optimistic message", () => {
    expect(classifyTurnStreamError(new ApiError(409, "Conflict", "active", "SESSION_ACTIVE_TURN_CONFLICT"))).toBe("session_active_turn");
    expect(removeOptimisticMessage([
      { type: "message", id: "optimistic", message: { id: "optimistic", role: "user", body: "hello", createdAt: "now" } },
    ], "optimistic")).toEqual([]);
  });

  it("does not treat an unrelated 409 as replay gap", () => {
    expect(classifyTurnStreamError(new ApiError(409, "Conflict", "other", "SOME_OTHER_CONFLICT"))).toBe("other_conflict");
  });

  it("clears processing only when there is no active or pending Turn", () => {
    expect(isSessionTurnProcessing(undefined, true)).toBe(true);
    expect(isSessionTurnProcessing(undefined, false)).toBe(false);
  });

  it("clears a failed subscription without clearing a newer Turn", () => {
    expect(shouldClearTurnAfterFailure("t1", "t1")).toBe(true);
    expect(shouldClearTurnAfterFailure(undefined, "t1")).toBe(false);
    expect(shouldClearTurnAfterFailure("t2", "t1")).toBe(false);
  });

  it("keeps one subscriber when returning from B to a running A", () => {
    expect(shouldStartTurnSubscription(true)).toBe(false);
    expect(shouldStartTurnSubscription(false)).toBe(true);
    expect(planActiveTurnRecovery(active(12), "t1")).toEqual({ kind: "reattach", turnId: "t1", afterSequence: 12 });
  });

  it("reloads durable history when active-turn is null", () => {
    expect(planActiveTurnRecovery({ activeTurn: null })).toEqual({ kind: "reload_history" });
  });
});
