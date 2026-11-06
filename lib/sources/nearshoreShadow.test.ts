import { describe, it, expect } from "vitest";
import { summarizeClarity, type ClarityFeed } from "@/lib/sources/clarity";
import { summarizeSeaweed, type CamSeaweedFeed } from "@/lib/sources/sargassum";
import { summarizeBusyness, type CamFeed } from "@/lib/sources/busyness";

/**
 * NEAR-SHORE SHADOW (scripts/cam_seaweed.py, 2026-11-06): the reader adds extra
 * fields to the cam feed — `waterNear` on each cam reading, `nearMedian` on a
 * capture group, a sparse `near` on history entries and a top-level
 * `nearScoredAt` map. They are shadow data only. This test proves the app's
 * three feed readers give the SAME output with and without them.
 */

const T = "2026-11-06T14:20-05:00";
const cams = [
  { id: "boca-inlet-surf", name: "Inlet", level: "none", coveragePct: 1, crowd: "quiet", crowdPct: 20, people: 3,
    water: "clear", waterPct: 74, waterNote: "blue", provider: "clef", scoredAt: "2026-11-06T19:20:00Z" },
  { id: "boca-south-surf", name: "South surf", level: "none", coveragePct: 0, crowd: "moderate", crowdPct: 40,
    people: 25, water: "clear", waterPct: 74, waterNote: "blue", provider: "clef", scoredAt: "2026-11-06T19:20:00Z" },
  { id: "boca-south", name: "South", level: "low", coveragePct: 4, crowd: "moderate", crowdPct: 45, people: 30,
    water: "slightly_murky", waterPct: 65, waterNote: "green", provider: "clef", scoredAt: "2026-11-06T19:20:00Z" },
];
const history = [
  { t: "2026-11-06T13:20-05:00", hour: 13, level: "quiet", people: 10, crowdPct: 30, seaweed: "none", cov: 0, water: "clear", clr: 73 },
  { t: T, hour: 14, level: "moderate", people: 30, crowdPct: 45, seaweed: "low", cov: 4, water: "clear", clr: 74 },
];

function baseFeed() {
  const group = { capturedAtLocal: T, hour: 14, cams: cams.map((c) => ({ ...c })) };
  return {
    generatedAt: "2026-11-06T19:21:00Z",
    dateLocal: "2026-11-06",
    tz: "America/New_York",
    latest: group,
    morning: { ...group, capturedAtLocal: "2026-11-06T09:20-05:00", hour: 9 },
    lastSeaweed: group,
    lastWater: group,
    history: history.map((e) => ({ ...e })),
  };
}

function withShadow() {
  const f = baseFeed();
  const near = (level: string, carried = false) => ({
    level, color: "sandy_green", sand: "some", bottom: "no", foam: "some", note: "olive water near shore",
    model: "gemini-x", scoredAt: "2026-11-06T19:20:00Z", ...(carried ? { carried: true } : {}),
  });
  for (const g of [f.latest, f.morning, f.lastSeaweed, f.lastWater]) {
    g.cams = g.cams.map((c, i) => ({ ...c, waterNear: near(i === 1 ? "murky" : "a_bit_sandy", i === 2) }));
    (g as Record<string, unknown>).nearMedian = {
      level: "murky", n: 2, fresh: 2, cams: { "boca-inlet-surf": "a_bit_sandy", "boca-south-surf": "murky" },
    };
  }
  f.history = f.history.map((e, i) => (i === 1 ? { ...e, near: "a_bit_sandy" } : e));
  (f as Record<string, unknown>).nearScoredAt = { "boca-inlet-surf": "2026-11-06T19:20:00Z" };
  return f;
}

describe("near-shore shadow fields do not change what the app shows", () => {
  const now = new Date("2026-11-06T19:25:00Z");
  const gate = { now, timezone: "America/New_York", nowLocalDate: "2026-11-06" };

  it("water clarity is unchanged", () => {
    const a = summarizeClarity(baseFeed() as unknown as ClarityFeed, gate);
    const b = summarizeClarity(withShadow() as unknown as ClarityFeed, gate);
    expect(a).not.toBeNull();
    expect(a!.pct).toBe(74);
    expect(b).toEqual(a);
  });

  it("seaweed is unchanged", () => {
    const a = summarizeSeaweed(baseFeed() as unknown as CamSeaweedFeed, "2026-11-06");
    const b = summarizeSeaweed(withShadow() as unknown as CamSeaweedFeed, "2026-11-06");
    expect(a).not.toBeNull();
    expect(b).toEqual(a);
  });

  it("busyness is unchanged", () => {
    const a = summarizeBusyness(baseFeed() as unknown as CamFeed, gate, "2026-11-06");
    const b = summarizeBusyness(withShadow() as unknown as CamFeed, gate, "2026-11-06");
    expect(b).toEqual(a);
  });
});
