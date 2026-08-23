import { describe, it, expect, vi, afterEach } from "vitest";
import {
  summarizeClarity,
  fetchClarity,
  clarityDisplayWord,
  clarityTileCopy,
  type ClarityFeed,
} from "@/lib/sources/clarity";
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
  it("reports the MEDIAN cam as the headline (calibrated vs owner in-water truth)", () => {
    const d = summarizeClarity(
      feed([
        { name: "A", water: "clear", waterPct: 90, waterNote: "gin-clear" },
        { name: "B", water: "murky", waterPct: 45, waterNote: "stirred up near shore" },
        { name: "C", water: "slightly_murky", waterPct: 70, waterNote: "greenish" },
      ]),
    );
    expect(d).not.toBeNull();
    expect(d!.level).toBe("slightly_murky");
    expect(d!.pct).toBe(70);
    expect(d!.note).toBe("greenish");
    expect(d!.perCam).toHaveLength(3);
    expect(d!.capturedAtLocal).toBe("2026-07-22T16:00:00-04:00");
    expect(d!.status).toBeUndefined();
  });

  it("2026-07-24 calibration case: 25/65/85 reads → median 65, not worst-of 25 (owner truth: 75)", () => {
    const d = summarizeClarity(
      feed([
        { name: "inlet", water: "murky", waterPct: 25, waterNote: "brownish near shore due to seaweed" },
        { name: "south-surf", water: "slightly_murky", waterPct: 65, waterNote: "greenish near shore" },
        { name: "south", water: "clear", waterPct: 85 },
      ]),
    );
    expect(d!.pct).toBe(65);
    expect(d!.level).toBe("slightly_murky");
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

  it("even cam count → median is the rounded mean of the middle two", () => {
    const d = summarizeClarity(
      feed([
        { name: "A", water: "murky", waterPct: 50 },
        { name: "B", water: "murky", waterPct: 30 },
      ]),
    );
    expect(d!.pct).toBe(40);
    expect(d!.level).toBe("murky");
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

// --- Overnight fallback ----------------------------------------------------

describe("summarizeClarity — the last readable day (overnight fallback)", () => {
  const read = (date: string, hour: number, clr: number, water = "clear") => ({
    t: `${date}T${String(hour).padStart(2, "0")}:00:00-04:00`,
    hour,
    water,
    clr,
  });
  // Fri 08-21: two reads (too thin). Sat 08-22: four. Sun 08-23: five, clearer
  // in the morning than the afternoon.
  const history = [
    read("2026-08-21", 10, 20, "murky"),
    read("2026-08-21", 12, 20, "murky"),
    read("2026-08-22", 8, 40, "murky"),
    read("2026-08-22", 11, 50, "slightly_murky"),
    read("2026-08-22", 14, 60, "slightly_murky"),
    read("2026-08-22", 17, 70),
    read("2026-08-23", 8, 80),
    read("2026-08-23", 10, 78),
    read("2026-08-23", 13, 72),
    read("2026-08-23", 15, 66, "slightly_murky"),
    read("2026-08-23", 17, 64, "slightly_murky"),
  ];
  const tz = "America/New_York";
  const sunriseIso = "2026-08-23T06:50:00-04:00";
  const tomorrowSunriseIso = "2026-08-24T06:51:00-04:00";
  const gated = (now: string, nowLocalDate: string) =>
    summarizeClarity(
      { latest: { capturedAtLocal: "2026-08-23T17:00:00-04:00", cams: [] }, history: history as never },
      { now: new Date(now), timezone: tz, sunriseIso, tomorrowSunriseIso, nowLocalDate },
    );

  it("at 11 PM, summarizes TODAY's daylight reads with the median clarity", () => {
    const d = gated("2026-08-23T23:00:00-04:00", "2026-08-23");
    expect(d!.yesterday).toMatchObject({
      dateLocal: "2026-08-23",
      dayLabel: "today",
      pct: 72, // median of 80/78/72/66/64
      word: "Mostly clear",
      reads: 5,
    });
  });

  it("splits the day into morning and afternoon medians when both halves have reads", () => {
    const d = gated("2026-08-23T23:00:00-04:00", "2026-08-23");
    expect(d!.yesterday?.amPct).toBe(79); // (80+78)/2
    expect(d!.yesterday?.pmPct).toBe(66); // median of 72/66/64
  });

  it("omits the am/pm split when the day only ran one half", () => {
    const morningOnly = [read("2026-08-22", 7, 60), read("2026-08-22", 9, 70), read("2026-08-22", 11, 80)];
    const d = summarizeClarity(
      { latest: { cams: [] }, history: morningOnly as never },
      { now: new Date("2026-08-22T23:00:00-04:00"), timezone: tz, nowLocalDate: "2026-08-22" },
    );
    expect(d!.yesterday?.pct).toBe(70);
    expect(d!.yesterday?.amPct).toBeUndefined();
    expect(d!.yesterday?.pmPct).toBeUndefined();
  });

  it("at 1 AM, the day that just ended is 'yesterday'", () => {
    const d = gated("2026-08-24T01:00:00-04:00", "2026-08-24");
    expect(d!.yesterday?.dateLocal).toBe("2026-08-23");
    expect(d!.yesterday?.dayLabel).toBe("yesterday");
  });

  it("walks back past a day with fewer than three daylight clarity reads", () => {
    const thin = history.filter((e) => !e.t.startsWith("2026-08-23"));
    const d = summarizeClarity(
      { latest: { cams: [] }, history: thin as never },
      { now: new Date("2026-08-23T23:00:00-04:00"), timezone: tz, nowLocalDate: "2026-08-23" },
    );
    expect(d!.yesterday).toMatchObject({
      dateLocal: "2026-08-22",
      dayLabel: "yesterday",
      pct: 55, // (50+60)/2
      word: "A bit murky",
      reads: 4,
    });
  });

  it("returns null when no day carries enough clarity reads", () => {
    const d = summarizeClarity(
      { latest: { cams: [] }, history: [read("2026-08-22", 10, 50)] as never },
      { now: new Date("2026-08-23T23:00:00-04:00"), timezone: tz, nowLocalDate: "2026-08-23" },
    );
    expect(d!.yesterday).toBeNull();
    expect(d!.note).toMatch(/dark/i);
  });

  it("keeps the gated reading level-null 'unknown' — the day summary is display-only", () => {
    const d = gated("2026-08-23T23:00:00-04:00", "2026-08-23");
    expect(d!.level).toBeNull();
    expect(d!.pct).toBeNull();
    expect(d!.status).toBe("unknown");
    expect(d!.yesterday).not.toBeNull();
  });

  it("attaches nothing extra to a live daytime reading", () => {
    const d = summarizeClarity(
      {
        latest: {
          capturedAtLocal: "2026-08-23T15:00:00-04:00",
          cams: [{ name: "A", water: "clear", waterPct: 80 }] as never,
        },
        history: history as never,
      },
      { now: new Date("2026-08-23T15:30:00-04:00"), timezone: tz, sunriseIso, nowLocalDate: "2026-08-23" },
    );
    expect(d!.level).toBe("clear");
    expect(d!.yesterday).toBeUndefined();
    expect(d!.nextReadIso).toBeUndefined();
  });

  it("says when the next cam read lands (tomorrow's sunrise minus the buffer)", () => {
    const d = gated("2026-08-23T23:00:00-04:00", "2026-08-23");
    expect(d!.nextReadIso).toBe(new Date("2026-08-24T06:21:00-04:00").toISOString());
  });

  it("uses today's sunrise for the next read at 1 AM", () => {
    const d = summarizeClarity(
      { latest: { cams: [] }, history: history as never },
      {
        now: new Date("2026-08-24T01:00:00-04:00"),
        timezone: tz,
        sunriseIso: "2026-08-24T06:51:00-04:00",
        tomorrowSunriseIso: "2026-08-25T06:52:00-04:00",
        nowLocalDate: "2026-08-24",
      },
    );
    expect(d!.nextReadIso).toBe(new Date("2026-08-24T06:21:00-04:00").toISOString());
  });
});

describe("clarityTileCopy — what the tile actually says", () => {
  const tz = "America/New_York";

  it("shows the live reading as before", () => {
    const c = clarityTileCopy(
      {
        level: "clear",
        pct: 78,
        note: "blue-green past the surf",
        capturedAtLocal: "2026-08-23T15:00:00-04:00",
      },
      tz,
    );
    expect(c.value).toBe("Mostly clear");
    expect(c.sub).toBe("~78% clear · blue-green past the surf · as of 3:00 PM");
    expect(c.pct).toBe(78);
    expect(c.muted).toBeUndefined();
  });

  it("shows the last readable day, dimmed, with the next read time", () => {
    const c = clarityTileCopy(
      {
        level: null,
        pct: null,
        status: "unknown",
        note: "cams can't read the water in the dark",
        nextReadIso: "2026-08-24T06:21:00-04:00",
        yesterday: {
          dateLocal: "2026-08-23",
          dayLabel: "yesterday",
          pct: 72,
          word: "Mostly clear",
          reads: 5,
        },
      },
      tz,
    );
    expect(c.value).toBe("Yesterday: Mostly clear");
    expect(c.sub).toBe("~72% clear · next cam read ~6:21 AM");
    expect(c.pct).toBe(72); // the scene still draws something, just muted
    expect(c.muted).toBe(true);
  });

  it("calls out a big morning/afternoon gap, and stays quiet about a small one", () => {
    const base = {
      level: null,
      pct: null,
      status: "unknown" as const,
      nextReadIso: "2026-08-24T06:21:00-04:00",
    };
    const day = { dateLocal: "2026-08-23", dayLabel: "today", pct: 72, word: "Mostly clear", reads: 5 };
    expect(
      clarityTileCopy({ ...base, yesterday: { ...day, amPct: 85, pmPct: 60 } }, tz).sub,
    ).toBe("~72% clear · 85% AM, 60% PM · next cam read ~6:21 AM");
    expect(
      clarityTileCopy({ ...base, yesterday: { ...day, amPct: 74, pmPct: 70 } }, tz).sub,
    ).toBe("~72% clear · next cam read ~6:21 AM");
  });

  it("falls back to the reason when the outage has no known end (a stale daytime frame)", () => {
    const c = clarityTileCopy(
      {
        level: null,
        pct: null,
        status: "unknown",
        note: "latest cam capture is a couple hours old",
        yesterday: {
          dateLocal: "2026-08-23",
          dayLabel: "today",
          pct: 72,
          word: "Mostly clear",
          reads: 5,
        },
      },
      tz,
    );
    expect(c.sub).toBe("~72% clear · latest cam capture is a couple hours old");
    expect(c.muted).toBe(true);
  });

  it("keeps the honest note plus the next read time when there's no day behind us", () => {
    const c = clarityTileCopy(
      {
        level: null,
        pct: null,
        status: "unknown",
        note: "cams can't read the water in the dark",
        nextReadIso: "2026-08-24T06:21:00-04:00",
        yesterday: null,
      },
      tz,
    );
    expect(c.value).toBe("—");
    expect(c.sub).toBe("cams can't read the water in the dark · next cam read ~6:21 AM");
    expect(c.pct).toBeNull();
  });
});
