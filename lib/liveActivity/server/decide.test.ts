import { describe, it, expect } from "vitest";
import {
  decideLiveActivitySend,
  lightningEscalated,
  safeParseState,
  LIVE_ACTIVITY_UPDATE_MIN_GAP_MS,
  LIVE_ACTIVITY_HEARTBEAT_MS,
} from "@/lib/liveActivity/server/decide";
import type { BeachSessionContentState } from "@/lib/liveActivity/state";

const NOW = 2_000_000_000_000;

function state(over: Partial<BeachSessionContentState> = {}): BeachSessionContentState {
  return { score: 80, updatedAt: NOW, ...over };
}

describe("lightningEscalated", () => {
  it("turning active is an escalation", () => {
    expect(lightningEscalated(undefined, { active: true, latched: false, miles: 4 })).toBe(true);
    expect(lightningEscalated({ active: false, latched: false }, { active: true, latched: false, miles: 4 })).toBe(
      true,
    );
  });

  it("going from active-far to active-close (within LIGHTNING_ESCALATE_MI) is an escalation", () => {
    expect(
      lightningEscalated(
        { active: true, latched: false, miles: 4 },
        { active: true, latched: true, miles: 1.5 },
      ),
    ).toBe(true);
  });

  it("staying active and far, or turning inactive, is not an escalation", () => {
    expect(
      lightningEscalated({ active: true, latched: false, miles: 4 }, { active: true, latched: true, miles: 3.8 }),
    ).toBe(false);
    expect(lightningEscalated({ active: true, latched: true, miles: 1 }, { active: false, latched: false })).toBe(
      false,
    );
    expect(lightningEscalated(undefined, undefined)).toBe(false);
  });
});

describe("decideLiveActivitySend — the fan-out decision table", () => {
  it("lightning turning active sends immediately at priority 10, bypassing the debounce", () => {
    const desired = state({ lightning: { active: true, latched: false, miles: 3 } });
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired,
      desiredHash: "h1",
      prevState: state({}), // no prior lightning
      lastStateHash: "h0", // even if the hash also changed
      lastSentAt: NOW - 5_000, // even inside the 60s debounce window
    });
    expect(decision).toMatchObject({ send: true, reason: "lightning", priority: 10 });
  });

  it("lightning escalating (far -> within the escalation radius) also sends immediately", () => {
    const prev = state({ lightning: { active: true, latched: false, miles: 4 } });
    const desired = state({ lightning: { active: true, latched: true, miles: 1.2 } });
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired,
      desiredHash: "h1",
      prevState: prev,
      lastStateHash: "h1", // hash didn't even change (contrived, still escalates)
      lastSentAt: NOW - 1_000,
    });
    expect(decision).toMatchObject({ send: true, reason: "lightning", priority: 10 });
  });

  it("a changed hash at least 60s after the last send sends an ordinary update", () => {
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ score: 85 }),
      desiredHash: "new-hash",
      prevState: state({ score: 80 }),
      lastStateHash: "old-hash",
      lastSentAt: NOW - LIVE_ACTIVITY_UPDATE_MIN_GAP_MS,
    });
    expect(decision).toMatchObject({ send: true, reason: "update", priority: 5 });
  });

  it("a changed hash less than 60s after the last send waits", () => {
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ score: 85 }),
      desiredHash: "new-hash",
      prevState: state({ score: 80 }),
      lastStateHash: "old-hash",
      lastSentAt: NOW - (LIVE_ACTIVITY_UPDATE_MIN_GAP_MS - 1),
    });
    expect(decision.send).toBe(false);
  });

  it("an unchanged hash sends the ~15-minute freshness heartbeat", () => {
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ score: 80 }),
      desiredHash: "same-hash",
      prevState: state({ score: 80 }),
      lastStateHash: "same-hash",
      lastSentAt: NOW - LIVE_ACTIVITY_HEARTBEAT_MS,
    });
    expect(decision).toMatchObject({ send: true, reason: "heartbeat", priority: 5 });
    expect(decision.staleDateMs).toBeGreaterThan(NOW);
  });

  it("no freshness heartbeat while the read is unavailable (Codex review #8)", () => {
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ unavailable: true }),
      desiredHash: "same-hash",
      prevState: state({ unavailable: true }),
      lastStateHash: "same-hash",
      lastSentAt: NOW - LIVE_ACTIVITY_HEARTBEAT_MS,
    });
    expect(decision.send).toBe(false);
  });

  it("a genuine change into `unavailable` still sends once, even though heartbeats are muted after it", () => {
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ unavailable: true }),
      desiredHash: "new-hash",
      prevState: state({}),
      lastStateHash: "old-hash",
      lastSentAt: NOW - LIVE_ACTIVITY_UPDATE_MIN_GAP_MS,
    });
    expect(decision).toMatchObject({ send: true, reason: "update" });
  });

  it("nothing to send: unchanged hash, inside both the debounce and the heartbeat window", () => {
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ score: 80 }),
      desiredHash: "same-hash",
      prevState: state({ score: 80 }),
      lastStateHash: "same-hash",
      lastSentAt: NOW - 60_000, // well inside the 15-min heartbeat window
    });
    expect(decision.send).toBe(false);
  });

  it("a never-sent activity (lastSentAt null) with an unchanged hash still sends (treated as overdue)", () => {
    const decision = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ score: 80 }),
      desiredHash: "h",
      prevState: null,
      lastStateHash: null,
      lastSentAt: null,
    });
    expect(decision.send).toBe(true);
  });

  it("relevance score is 100 while lightning is active, 50 otherwise", () => {
    const active = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({ lightning: { active: true, latched: true, miles: 3 } }),
      desiredHash: "h1",
      prevState: state({ lightning: { active: true, latched: true, miles: 3 } }),
      lastStateHash: "old",
      lastSentAt: NOW - LIVE_ACTIVITY_UPDATE_MIN_GAP_MS,
    });
    expect(active.relevanceScore).toBe(100);

    const quiet = decideLiveActivitySend({
      nowMs: NOW,
      desired: state({}),
      desiredHash: "h2",
      prevState: state({}),
      lastStateHash: "old",
      lastSentAt: NOW - LIVE_ACTIVITY_UPDATE_MIN_GAP_MS,
    });
    expect(quiet.relevanceScore).toBe(50);
  });
});

describe("safeParseState", () => {
  it("parses a stored blob", () => {
    expect(safeParseState('{"score":50,"updatedAt":1}')).toEqual({ score: 50, updatedAt: 1 });
  });
  it("null/undefined/corrupt all read as no prior state", () => {
    expect(safeParseState(null)).toBeNull();
    expect(safeParseState(undefined)).toBeNull();
    expect(safeParseState("{not json")).toBeNull();
  });
});
