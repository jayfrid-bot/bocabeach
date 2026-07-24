import { describe, it, expect, vi, afterEach } from "vitest";
import { summarizeClarity, fetchClarity, clarityDisplayWord, type ClarityFeed } from "@/lib/sources/clarity";
import type { Location } from "@/lib/types";

const CAMLESS_LOCATION: Location = {
  slug: "test-beach",
  name: "Test Beach",
  region: "Test County, CA",
  tier: "auto",
  lat: 34.0,
  lon: -118.5,
  timezone: "America/Los_Angeles",
  noaaTideStationId: "9410840",
  ndbcBuoyId: "icac1",
  cams: [],
};

// A capture group with clarity-bearing cams.
const feed = (cams: unknown[], capturedAtLocal = "2026-07-22T16:00:00-04:00"): ClarityFeed => ({
  latest: { capturedAtLocal, cams: cams as never },
});

describe("summarizeClarity — parses a with-clarity capture", () => {
  it("reports the WORST (murkiest) cam as the headline", () => {
    const d = summarizeClarity(
      feed([
        { name: "A", water: "clear", waterPct: 90, waterNote: "gin-clear" },
        { name: "B", water: "murky", waterPct: 45, waterNote: "stirred up near shore" },
        { name: "C", water: "slightly_murky", waterPct: 70 },
      ]),
    );
    expect(d).not.toBeNull();
    expect(d!.level).toBe("murky");
    expect(d!.pct).toBe(45);
    expect(d!.note).toBe("stirred up near shore");
    expect(d!.perCam).toHaveLength(3);
    expect(d!.capturedAtLocal).toBe("2026-07-22T16:00:00-04:00");
    expect(d!.status).toBeUndefined();
  });

  it("only includes cams that saw open water (water null = no reading)", () => {
    const d = summarizeClarity(
      feed([
        { name: "A", water: "clear", waterPct: 88 },
        { name: "B", water: null, waterPct: null, waterNote: "in shadow" },
      ]),
    );
    expect(d!.level).toBe("clear");
    expect(d!.pct).toBe(88);
    expect(d!.perCam).toHaveLength(1);
    expect(d!.perCam?.[0].name).toBe("A");
  });

  it("clamps clarity % to 0-100 and rounds", () => {
    const d = summarizeClarity(feed([{ name: "A", water: "clear", waterPct: 143.6 }]));
    expect(d!.pct).toBe(100);
  });

  it("ties on grade break to the lower clarity %", () => {
    const d = summarizeClarity(
      feed([
        { name: "A", water: "murky", waterPct: 50 },
        { name: "B", water: "murky", waterPct: 30 },
      ]),
    );
    expect(d!.pct).toBe(30);
  });

  it("degrades to a level-null 'unknown' when a capture shows no open water", () => {
    const d = summarizeClarity(feed([{ name: "A", water: null }, { name: "B", water: null }]));
    expect(d).not.toBeNull();
    expect(d!.level).toBeNull();
    expect(d!.status).toBe("unknown");
    expect(d!.note).toMatch(/open water/i);
  });
});

describe("summarizeClarity — legacy feed without clarity fields", () => {
  it("returns null (unavailable) when no cam carries a water field", () => {
    // Old-shape entries: seaweed/crowd only, no `water` key at all.
    const legacy: ClarityFeed = {
      latest: {
        capturedAtLocal: "2026-07-20T16:00:00-04:00",
        cams: [{ name: "A", level: "low", crowd: "quiet" }] as never,
      },
      history: [{ t: "2026-07-20T12:00:00-04:00", hour: 12, seaweed: "low" }] as never,
    };
    expect(summarizeClarity(legacy)).toBeNull();
  });

  it("still reads clarity when only the history carries the new fields", () => {
    // A frame with no current cams, but today's history has water/clr → the feed
    // HAS clarity fields, so it's not treated as a legacy feed (returns non-null).
    const withHistory: ClarityFeed = {
      latest: { capturedAtLocal: "2026-07-22T16:00:00-04:00", cams: [] },
      history: [{ t: "2026-07-22T12:00:00-04:00", hour: 12, water: "clear", clr: 90 }],
    };
    const d = summarizeClarity(withHistory);
    expect(d).not.toBeNull();
    // No current cams saw water → level-null unknown, not a fabricated read.
    expect(d!.level).toBeNull();
    expect(d!.status).toBe("unknown");
  });

  it("returns null for an empty feed", () => {
    expect(summarizeClarity({})).toBeNull();
  });
});

describe("summarizeClarity — night / staleness gate", () => {
  const cams = [{ name: "A", water: "clear", waterPct: 90 }];
  const tz = "America/New_York";

  it("degrades a night capture to level-null unknown with a reason", () => {
    // 11 PM local — outside the 6-20 readable window.
    const now = new Date("2026-07-22T23:00:00-04:00");
    const d = summarizeClarity(feed(cams, "2026-07-22T19:00:00-04:00"), { now, timezone: tz });
    expect(d!.level).toBeNull();
    expect(d!.status).toBe("unknown");
    expect(d!.note).toMatch(/dark/i);
  });

  it("degrades a pre-dawn capture (before 6am local) to unknown", () => {
    const now = new Date("2026-07-22T05:30:00-04:00");
    const d = summarizeClarity(feed(cams, "2026-07-22T05:00:00-04:00"), { now, timezone: tz });
    expect(d!.level).toBeNull();
    expect(d!.note).toMatch(/dark/i);
  });

  it("degrades a stale daytime capture (>2h old) to unknown even mid-afternoon", () => {
    const now = new Date("2026-07-22T16:00:00-04:00"); // daylight
    const d = summarizeClarity(feed(cams, "2026-07-22T13:00:00-04:00"), { now, timezone: tz }); // 3h old
    expect(d!.level).toBeNull();
    expect(d!.status).toBe("unknown");
    expect(d!.note).toMatch(/stale|old/i);
  });

  it("leaves a fresh daytime capture unchanged", () => {
    const now = new Date("2026-07-22T16:30:00-04:00");
    const d = summarizeClarity(feed(cams, "2026-07-22T16:00:00-04:00"), { now, timezone: tz });
    expect(d!.level).toBe("clear");
    expect(d!.note).toBeUndefined();
    expect(d!.status).toBeUndefined();
  });

  it("still works with no gate options passed at all (parse-only callers)", () => {
    const d = summarizeClarity(feed(cams, "2026-07-22T16:00:00-04:00"));
    expect(d!.level).toBe("clear");
  });
});

const CAM_LOCATION: Location = {
  ...CAMLESS_LOCATION,
  cams: [{ name: "Cam", provider: "test", embedType: "link", url: "https://example.test" }],
};

describe("fetchClarity — cam gating + failure", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns no data for a cam-less beach (clarity is cam-derived, not global)", async () => {
    const w = await fetchClarity(CAMLESS_LOCATION);
    expect(w.data).toBeNull();
    expect(w.status).toBe("best-effort");
    expect(w.note).toMatch(/no beach cams/i);
  });

  it("reports an honest error when the feed is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const w = await fetchClarity(CAM_LOCATION);
    expect(w.data).toBeNull();
    expect(w.status).toBe("error");
    expect(w.note).toMatch(/network down/i);
  });

  it("reports 'not published yet' on a 404 rather than an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 404, headers: { date: "Wed, 22 Jul 2026 16:00:00 GMT" } }),
    );
    const w = await fetchClarity(CAM_LOCATION);
    expect(w.data).toBeNull();
    expect(w.status).toBe("best-effort");
    expect(w.note).toMatch(/not published/i);
  });
});

describe("clarityDisplayWord — positively-framed band mapping from the clarity %", () => {
  it("bands the percentage, testing every edge", () => {
    // >= 85 "Crystal clear"
    expect(clarityDisplayWord("clear", 100)).toBe("Crystal clear");
    expect(clarityDisplayWord("clear", 85)).toBe("Crystal clear");
    // just under 85 falls to the next band
    expect(clarityDisplayWord("clear", 84)).toBe("Mostly clear");
    // 65-84 "Mostly clear"
    expect(clarityDisplayWord("slightly_murky", 65)).toBe("Mostly clear");
    expect(clarityDisplayWord("slightly_murky", 64)).toBe("A bit murky");
    // 45-64 "A bit murky"
    expect(clarityDisplayWord("murky", 45)).toBe("A bit murky");
    expect(clarityDisplayWord("murky", 44)).toBe("Murky");
    // 25-44 "Murky"
    expect(clarityDisplayWord("murky", 25)).toBe("Murky");
    expect(clarityDisplayWord("churned", 24)).toBe("Churned up");
    // < 25 "Very murky" (or "Churned up" when the grade itself is churned)
    expect(clarityDisplayWord("murky", 24)).toBe("Very murky");
    expect(clarityDisplayWord("murky", 0)).toBe("Very murky");
  });

  it("a 65% clear read shows the positive framing from the prompt example", () => {
    expect(clarityDisplayWord("slightly_murky", 65)).toBe("Mostly clear");
  });

  it("falls back to a positively-adjusted grade word when pct is null", () => {
    expect(clarityDisplayWord("clear", null)).toBe("Clear");
    expect(clarityDisplayWord("slightly_murky", null)).toBe("Mostly clear");
    expect(clarityDisplayWord("murky", null)).toBe("Murky");
    expect(clarityDisplayWord("churned", null)).toBe("Churned up");
  });

  it("returns an empty string when there's no level to describe", () => {
    expect(clarityDisplayWord(null, null)).toBe("");
    expect(clarityDisplayWord(undefined, undefined)).toBe("");
  });
});
