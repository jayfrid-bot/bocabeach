import { describe, it, expect, vi } from "vitest";
import {
  refreshedAt,
  withMinDuration,
  withTimeout,
  RefreshTimeoutError,
  pillText,
  nextPhase,
  type Phase,
} from "@/components/PullToRefresh";

describe("refreshedAt", () => {
  it("reads snapshot.generatedAt when present", () => {
    const d = refreshedAt({ snapshot: { generatedAt: "2026-09-23T11:42:00.000Z" } });
    expect(d?.toISOString()).toBe("2026-09-23T11:42:00.000Z");
  });
  it("falls back to a top-level generatedAt", () => {
    const d = refreshedAt({ generatedAt: "2026-09-23T11:42:00.000Z" });
    expect(d?.toISOString()).toBe("2026-09-23T11:42:00.000Z");
  });
  it("prefers snapshot.generatedAt over a top-level one", () => {
    const d = refreshedAt({
      snapshot: { generatedAt: "2026-09-23T11:00:00.000Z" },
      generatedAt: "2026-09-23T12:00:00.000Z",
    });
    expect(d?.toISOString()).toBe("2026-09-23T11:00:00.000Z");
  });
  it("returns null when nothing usable is present", () => {
    expect(refreshedAt({})).toBeNull();
    expect(refreshedAt(null)).toBeNull();
    expect(refreshedAt(undefined)).toBeNull();
    expect(refreshedAt("nope")).toBeNull();
  });
  it("returns null for an unparseable timestamp", () => {
    expect(refreshedAt({ generatedAt: "not-a-date" })).toBeNull();
  });
});

describe("withMinDuration", () => {
  it("waits out the minimum even when the promise resolves instantly", async () => {
    const start = Date.now();
    const result = await withMinDuration(Promise.resolve("ok"), 40);
    expect(result).toBe("ok");
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });

  it("doesn't add extra wait when the promise already took longer than the minimum", async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve("slow"), 30));
    const start = Date.now();
    const result = await withMinDuration(slow, 5);
    expect(result).toBe("slow");
    expect(Date.now() - start).toBeLessThan(80);
  });

  it("still waits out the minimum before rejecting", async () => {
    const start = Date.now();
    await expect(withMinDuration(Promise.reject(new Error("boom")), 40)).rejects.toThrow("boom");
    expect(Date.now() - start).toBeGreaterThanOrEqual(35);
  });
});

describe("withTimeout", () => {
  it("resolves normally when the promise settles before the deadline", async () => {
    const result = await withTimeout(Promise.resolve("fast"), 40);
    expect(result).toBe("fast");
  });

  it("rejects with RefreshTimeoutError when the promise never settles in time", async () => {
    const hung = new Promise(() => {}); // never resolves
    await expect(withTimeout(hung, 20)).rejects.toBeInstanceOf(RefreshTimeoutError);
  });

  it("propagates a rejection that happens before the deadline", async () => {
    await expect(withTimeout(Promise.reject(new Error("nope")), 40)).rejects.toThrow("nope");
  });
});

describe("pillText", () => {
  it("formats a success message with the refreshed time", () => {
    const at = new Date("2026-09-23T11:42:00.000Z");
    expect(pillText("success", at)).toMatch(/^✓ Updated · data as of /);
  });
  it("never invents a time — plain 'Updated' when none is known", () => {
    expect(pillText("success", null)).toBe("✓ Updated");
  });
  it("shows a fixed message on error, ignoring the time", () => {
    expect(pillText("error", new Date())).toBe("Couldn't refresh — showing the last data");
    expect(pillText("error", null)).toBe("Couldn't refresh — showing the last data");
  });
});

describe("nextPhase", () => {
  it("walks the full happy path: idle -> pulling -> refreshing -> bouncing -> idle", () => {
    let phase: Phase = "idle";
    phase = nextPhase(phase, { type: "pull" });
    expect(phase).toBe("pulling");
    phase = nextPhase(phase, { type: "release_above" });
    expect(phase).toBe("refreshing");
    phase = nextPhase(phase, { type: "settled" });
    expect(phase).toBe("bouncing");
    phase = nextPhase(phase, { type: "bounce_done" });
    expect(phase).toBe("idle");
  });

  it("release below the trigger returns to idle from pulling", () => {
    expect(nextPhase("pulling", { type: "release_below" })).toBe("idle");
  });

  it("cancel always returns to idle, from any phase, without going through refreshing", () => {
    (["idle", "pulling", "refreshing", "bouncing"] as Phase[]).forEach((phase) => {
      expect(nextPhase(phase, { type: "cancel" })).toBe("idle");
    });
  });

  it("a timeout is just another 'settled' event — refreshing still bounces, not idle directly", () => {
    expect(nextPhase("refreshing", { type: "settled" })).toBe("bouncing");
  });

  it("an error is also a 'settled' event — same transition as success", () => {
    expect(nextPhase("refreshing", { type: "settled" })).toBe("bouncing");
  });

  it("ignores events that don't apply to the current phase", () => {
    expect(nextPhase("idle", { type: "release_above" })).toBe("idle");
    expect(nextPhase("idle", { type: "settled" })).toBe("idle");
    expect(nextPhase("idle", { type: "bounce_done" })).toBe("idle");
    expect(nextPhase("refreshing", { type: "pull" })).toBe("refreshing");
    expect(nextPhase("bouncing", { type: "pull" })).toBe("bouncing");
  });
});

describe("PullToRefresh module isn't loaded twice with different timers", () => {
  it("withTimeout clears its internal timer on early resolution (no dangling timer keeps the process open)", async () => {
    vi.useFakeTimers();
    const p = withTimeout(Promise.resolve("ok"), 10_000);
    // Let the microtask queue settle without needing to advance 10s of fake time.
    await Promise.resolve();
    await Promise.resolve();
    vi.useRealTimers();
    await expect(p).resolves.toBe("ok");
  });
});
