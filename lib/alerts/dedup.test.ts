// The repeat window, and why an escalation has to have its own key.

import { describe, it, expect } from "vitest";
import { shouldFire, splitByDedup } from "@/lib/alerts/dedup";
import { buildAlert, DEFAULT_REPEAT_MS } from "@/lib/alerts/catalog";
import type { AlertMark } from "@/lib/db/types";

const NOW = Date.parse("2026-09-02T18:00:00Z");
const CTX = { beach: "Boca Raton" };

const mark = (sentAt: number): AlertMark => ({ sentAt, meta: null });

/** A store stub: whatever the map says was sent, and when. */
function lastOf(log: Record<string, number>) {
  return async (key: string): Promise<AlertMark | null> =>
    key in log ? mark(log[key]) : null;
}

describe("shouldFire", () => {
  it("fires a key that has never fired", () => {
    expect(shouldFire(null, NOW, DEFAULT_REPEAT_MS)).toBe(true);
  });

  it("holds inside the 30-minute window", () => {
    expect(shouldFire(mark(NOW - 29 * 60_000), NOW, DEFAULT_REPEAT_MS)).toBe(false);
  });

  it("fires again at exactly 30 minutes", () => {
    expect(shouldFire(mark(NOW - 30 * 60_000), NOW, DEFAULT_REPEAT_MS)).toBe(true);
  });

  it("fires when the stored time is unreadable", () => {
    expect(shouldFire({ sentAt: NaN, meta: null }, NOW, DEFAULT_REPEAT_MS)).toBe(true);
  });
});

describe("splitByDedup", () => {
  const lightning = buildAlert({ key: "lightning", nearestMi: 3.4, escalated: false }, CTX);
  const escalation = buildAlert({ key: "lightning", nearestMi: 1.4, escalated: true }, CTX);
  const rip = buildAlert({ key: "rip", level: "high" }, CTX);

  it("holds a key inside its window and lets a fresh one through", async () => {
    const r = await splitByDedup([lightning, rip], NOW, lastOf({ lightning: NOW - 10 * 60_000 }));
    expect(r.fire.map((d) => d.dedupKey)).toEqual(["rip"]);
    expect(r.held.map((d) => d.dedupKey)).toEqual(["lightning"]);
  });

  it("lets the escalation through even while the base key is still deduped", async () => {
    const r = await splitByDedup([lightning, escalation], NOW, lastOf({ lightning: NOW - 5 * 60_000 }));
    expect(r.fire.map((d) => d.dedupKey)).toEqual(["lightning:2mi"]);
  });

  it("re-fires the base key once its own window reopens, escalation untouched", async () => {
    const r = await splitByDedup(
      [lightning],
      NOW,
      lastOf({ lightning: NOW - 31 * 60_000, "lightning:2mi": NOW - 1 * 60_000 }),
    );
    expect(r.fire.map((d) => d.dedupKey)).toEqual(["lightning"]);
  });

  it("sends one push, not two, when a storm arrives already inside 2 miles", async () => {
    const r = await splitByDedup([lightning, escalation], NOW, lastOf({}));
    expect(r.fire.map((d) => d.dedupKey)).toEqual(["lightning:2mi"]);
    expect(r.supersededKeys).toEqual(["lightning"]); // still marked, so it stays quiet
  });

  it("keeps a moderate rip and a high rip on separate keys", async () => {
    const moderate = buildAlert({ key: "rip", level: "moderate" }, CTX);
    const r = await splitByDedup([rip, moderate], NOW, lastOf({ rip: NOW - 2 * 60_000 }));
    expect(r.fire.map((d) => d.dedupKey)).toEqual(["rip:moderate"]);
  });

  it("keeps each severe event on its own key", async () => {
    const a = buildAlert({ key: "severe", event: "Tornado Warning" }, CTX);
    const b = buildAlert({ key: "severe", event: "Flash Flood Warning" }, CTX);
    const r = await splitByDedup([a, b], NOW, lastOf({ "severe:Tornado Warning": NOW - 60_000 }));
    expect(r.fire.map((d) => d.dedupKey)).toEqual(["severe:Flash Flood Warning"]);
  });
});
