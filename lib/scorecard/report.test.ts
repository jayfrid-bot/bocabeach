import { describe, expect, it } from "vitest";
import { buildScorecard, renderMarkdown, type RawData } from "@/lib/scorecard/report";
import type { HourlyRow, SunPredictionRow } from "@/lib/scorecard/metrics";
import { camRoster } from "@/lib/camStatus";
import { LOCATIONS } from "@/config/locations";

const AS_OF = "2026-10-20T14:00:00.000Z";

const emptyRaw = (over: Partial<RawData> = {}): RawData => ({
  asOf: AS_OF,
  days: 14,
  hourly: [],
  sunPredictions: [],
  sunObservations: [],
  camLatest: [],
  sunPredictionsLast24h: 0,
  errors: {},
  ...over,
});

/** A sun forecast row for event `n`, forecast 3 hours ahead. */
function sunRow(n: number, score: number, observed: number | null): SunPredictionRow {
  const eventMs = Date.parse("2026-10-08T10:30:00Z") + n * 86_400_000;
  return {
    slug: "boca-raton",
    event_kind: "sunrise",
    event_iso: new Date(eventMs).toISOString(),
    as_of_hour_utc: new Date(eventMs - 3 * 3_600_000).toISOString(),
    lead_minutes: 180,
    score,
    band: null,
    algo_version: "2026-10-06.2",
    observed_score: observed,
    observed_source: observed == null ? null : "sun-cam:test:solar",
  };
}

describe("buildScorecard — nothing collected yet", () => {
  const card = buildScorecard(emptyRaw());
  const md = renderMarkdown(card);

  it("says collecting for every system, with the count and the minimum", () => {
    expect(card.headlines.sun).toContain("collecting — 0 of 10 pairs");
    expect(card.headlines.rain).toContain("collecting — 0 of 50 scored calls");
    expect(card.headlines.window).toContain("collecting — 0 of 10 days");
    expect(card.headlines.safety).toContain("collecting — 0 of 30 beach-days");
  });

  it("renders the sections in order under plain headings, with no error numbers", () => {
    const heads = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(heads).toEqual([
      "At a glance",
      "Sunrise and sunset color",
      "Rain forecast",
      "Best time to go",
      "Safety message and lifeguard flags",
      "Data health",
    ]);
    expect(md).not.toContain("Typical miss (pts)");
    expect(md).not.toContain("NaN");
    expect(md).not.toContain("undefined");
  });

  it("starts with a title and a one-line headline per system", () => {
    expect(md.startsWith("# Prediction scorecard — 2026-10-20")).toBe(true);
    const glance = md.split("## At a glance")[1].split("##")[0];
    expect(glance.match(/^- \*\*/gm)).toHaveLength(5);
  });
});

describe("buildScorecard — failures never throw", () => {
  it("a failed hourly query renders its sections as Not available with the error line", () => {
    const card = buildScorecard(
      emptyRaw({ hourly: null, errors: { hourly: "Authentication error [code: 10000]\nsecond line" } }),
    );
    expect(card.rain).toEqual({ ok: false, error: "Authentication error [code: 10000]" });
    expect(card.window.ok).toBe(false);
    expect(card.safety.ok).toBe(false);
    expect(card.health.ok).toBe(false);
    expect(card.sun.ok).toBe(true); // independent query: still scored
    const md = renderMarkdown(card);
    expect(md).toContain("Not available — Authentication error [code: 10000]");
    expect(md).not.toContain("second line");
  });

  it("a failed sun query leaves the other sections intact", () => {
    const card = buildScorecard(emptyRaw({ sunPredictions: null, errors: { sunPredictions: "D1 timeout" } }));
    expect(card.sun).toEqual({ ok: false, error: "D1 timeout" });
    expect(card.rain.ok).toBe(true);
    expect(card.headlines.sun).toBe("Not available — D1 timeout");
  });

  it("every dataset failing still renders a report", () => {
    const err = "wrangler failed";
    const card = buildScorecard({
      asOf: AS_OF,
      days: 14,
      hourly: null,
      sunPredictions: null,
      sunObservations: null,
      camLatest: null,
      sunPredictionsLast24h: null,
      errors: { hourly: err, sunPredictions: err, sunObservations: err, camLatest: err, sunPredictionsLast24h: err },
    });
    const md = renderMarkdown(card);
    expect(md.match(/Not available — wrangler failed/g)!.length).toBeGreaterThanOrEqual(5);
  });

  it("a partial load warns, and still scores what it has", () => {
    const card = buildScorecard(emptyRaw({ errors: { hourly: "chunk 2 failed" } }));
    expect(card.warnings[0]).toContain("chunk 2 failed");
    expect(card.rain.ok).toBe(true);
    expect(renderMarkdown(card)).toContain("> Warning: Some hourly rows are missing. chunk 2 failed");
  });

  it("a bug inside a metric becomes Not available, never an exception", () => {
    const bad = emptyRaw({ sunPredictions: [null as unknown as SunPredictionRow] });
    let card!: ReturnType<typeof buildScorecard>;
    expect(() => {
      card = buildScorecard(bad);
    }).not.toThrow();
    expect(card.sun.ok).toBe(false);
    expect(() => renderMarkdown(card)).not.toThrow();
  });
});

describe("buildScorecard — enough data", () => {
  // Sun: 12 paired events, forecast 10 high, so MAE 10 and bias +10.
  const sun: SunPredictionRow[] = Array.from({ length: 12 }, (_, n) => sunRow(n, 70 + n, 60 + n));

  // Hourly: one curated beach, 12 days, hours 0..23 each day.
  const hourly: HourlyRow[] = [];
  const ms = (day: number, hour: number) => Date.parse("2026-10-01T04:00:00Z") + (day * 24 + hour) * 3_600_000;
  for (let day = 0; day < 12; day++) {
    const date = `2026-10-${String(day + 1).padStart(2, "0")}`;
    for (let hour = 0; hour < 24; hour++) {
      hourly.push({
        slug: "boca-raton",
        hour_utc: new Date(ms(day, hour)).toISOString(),
        local_date: date,
        local_hour: hour,
        score: hour >= 7 && hour < 19 ? 60 : 70,
        has_extra: true,
        window:
          hour === 8
            ? { startIso: new Date(ms(day, 9)).toISOString(), endIso: new Date(ms(day, 15)).toISOString(), score: 64 }
            : null,
        // Rain: every hour of days 0-2 is a "dry for 2+ hrs" call; radar shows rain at day 0 hour 10 only.
        rain:
          day < 3
            ? {
                nowcast: "dry",
                changeInMin: null,
                radarMmHr: day === 0 && hour === 10 ? 2 : 0,
                radarDry: day === 0 && hour === 10 ? 0 : 1,
                radarAgeMin: 5,
              }
            : null,
        flags: null,
        safety: { swim: "safe" },
      });
    }
  }
  // Safety: one flag posting per day. Days 1-9 alternate yellow (we said caution) and green (we said safe),
  // so we agree; days 10-12 are red (we said stay out). That is 12 beach-days, under the 30 needed.
  for (const r of hourly) {
    const day = Number(r.local_date.slice(8));
    const color = day >= 10 ? "red" : day % 2 ? "yellow" : "green";
    const swim = day >= 10 ? "stay-out" : day % 2 ? "caution" : "safe";
    r.flags = { colors: [color] };
    r.safety = { swim };
  }

  const card = buildScorecard(
    emptyRaw({
      asOf: "2026-10-13T00:00:00.000Z",
      sunPredictions: sun,
      sunObservations: [
        {
          slug: "boca-raton",
          event_kind: "sunrise",
          event_date_local: "2026-10-08",
          cam_id: "c",
          event_iso: new Date(Date.parse("2026-10-08T10:30:00Z") + 5 * 60_000).toISOString(), // 5 min off: still matches
          view: "solar",
          observed_score: 60,
          scored_at: "2026-10-08T12:00:00Z",
        },
        {
          slug: "boca-raton",
          event_kind: "sunset",
          event_date_local: "2026-10-08",
          cam_id: "c",
          event_iso: "2026-10-08T23:00:00Z",
          view: "antisolar",
          observed_score: 30,
          scored_at: "2026-10-08T23:40:00Z",
        },
      ],
      hourly,
    }),
  );

  it("sun: the raw tables score 10+ pairs, but the headline waits for the forecast people see", () => {
    expect(card.sun.ok && card.sun.result.ready).toBe(true);
    const md = renderMarkdown(card);
    expect(md).toContain("| All pairs | 12 | 12 | 10.0 | +10.0 |");
    // Every row is 3 hours out, so no event has a 30–120 min forecast: the headline says collecting.
    expect(card.headlines.sun).toContain("Model 2026-10-06.2: collecting — 0 of 10 pairs (0 events with a forecast 30–120 min out).");
    // The other 7 events come after asOf, so they are not past events yet.
    expect(card.headlines.sun).toContain("A forecast 30–120 min out exists for 0 of 5 past sunrises (0%).");
  });

  it("sun: counts a camera reading with no forecast, and matches within 15 minutes", () => {
    expect(card.sun.ok && card.sun.result.observations).toBe(2);
    // the sunset reading is afterglow (antisolar): counted apart, never "unmatched" and never scored
    expect(card.sun.ok && card.sun.result.afterglowObservations).toBe(1);
    expect(card.sun.ok && card.sun.result.observationsWithoutForecast).toBe(0);
  });

  it("rain: the headline is the 'dry for 2+ hrs' promise", () => {
    // Rows of days 0-2 are calls (72); scored when +1 h and +2 h radar exist (the last 2 rows of day 2 have none).
    expect(card.rain.ok && card.rain.result.ready).toBe(true);
    // Rain showed at day 0 hour 10: the dry calls made at hours 8 and 9 (and hour 10's own row has radar at 11, 12: dry) were rained on.
    expect(card.headlines.rain).toMatch(/Of 70 "dry for the next 2\+ hrs" calls, 2 \(3%\) saw radar rain within 2 hours\./);
  });

  it("window: 10+ finished days score the window against the realized hours", () => {
    expect(card.window.ok && card.window.result.ready).toBe(true);
    expect(card.headlines.window).toContain("complete day");
    if (card.window.ok) {
      expect(card.window.result.realizedInWindow).toBe(60);
      expect(card.window.result.realizedBest3h).toBe(60);
      expect(card.window.result.gapPts).toBe(0);
      expect(card.window.result.windowScoreBias).toBe(4);
    }
  });

  it("safety: counts beach-days, so 12 flagged days stay under the 30 needed", () => {
    expect(card.safety.ok && card.safety.result.ready).toBe(false);
    if (card.safety.ok) {
      expect(card.safety.result.beachDays).toBe(12);
      expect(card.safety.result.hours).toBe(12 * 24);
      expect(card.safety.result.informative.beachDays).toBe(9);
    }
    expect(card.headlines.safety).toContain("collecting — 12 of 30 beach-days");
  });

  it("data health: no beach under the minimum when every hour is archived", () => {
    expect(card.health.ok).toBe(true);
    if (card.health.ok) {
      expect(card.health.result.beaches).toBe(1);
      expect(card.health.result.underMin).toEqual([]);
      expect(card.health.result.hourGaps?.missing).toEqual([]);
    }
    expect(card.headlines.health).toContain("No beach under 12 rows a day.");
  });

  it("renders every table without placeholders leaking through", () => {
    const md = renderMarkdown(card);
    expect(md).toContain("### Error overall and by group");
    expect(md).toContain("### Our call versus what happened");
    expect(md).toContain("### Swim message by flag (beach-days)");
    expect(md).toContain("### Green and yellow flags only");
    expect(md).not.toContain("NaN");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("collecting —  ");
  });
});

describe("buildScorecard — enough safety beach-days", () => {
  // 4 beaches x 10 days, a flag posting a day: 30 green/yellow beach-days + 10 red = 40.
  const hourly: HourlyRow[] = [];
  for (const [bi, slug] of ["a", "b", "c", "d"].entries()) {
    for (let day = 1; day <= 10; day++) {
      const red = bi === 3;
      for (let hour = 7; hour < 19; hour++) {
        hourly.push({
          slug,
          hour_utc: new Date(Date.UTC(2026, 9, day, hour + 4)).toISOString(),
          local_date: `2026-10-${String(day).padStart(2, "0")}`,
          local_hour: hour,
          score: 60,
          has_extra: true,
          flags: { colors: [red ? "red" : day % 2 ? "yellow" : "green"] },
          safety: { swim: red ? "stay-out" : day % 2 ? "caution" : "safe" },
        });
      }
    }
  }
  const card = buildScorecard(emptyRaw({ asOf: "2026-10-12T00:00:00.000Z", hourly }));

  it("reports the agreement rate once 30 green or yellow beach-days exist, red days left out", () => {
    expect(card.safety.ok && card.safety.result.ready).toBe(true);
    if (card.safety.ok) {
      expect(card.safety.result.beachDays).toBe(40);
      expect(card.safety.result.informative.beachDays).toBe(30);
      expect(card.safety.result.informative.agreement.value).toBe(1);
    }
    expect(card.headlines.safety).toContain("40 beach-days with a flag");
    expect(card.headlines.safety).toContain("agreed with the flag 100% of the time (30 of 30)");
  });
});

describe("buildScorecard — partial days and gated rates in the Markdown", () => {
  /** 12 days (the last one still in progress) of the normal archive pattern: local hours 16-19 missing, a window named at 8 AM. */
  const hourly: HourlyRow[] = [];
  for (let day = 1; day <= 12; day++) {
    for (let hour = 0; hour < 24; hour++) {
      if (hour >= 16 && hour <= 19) continue;
      hourly.push({
        slug: "boca-raton",
        hour_utc: new Date(Date.UTC(2026, 9, day, hour + 4)).toISOString(),
        local_date: `2026-10-${String(day).padStart(2, "0")}`,
        local_hour: hour,
        score: hour >= 7 && hour < 19 ? 60 : 70,
        has_extra: true,
        window:
          hour === 8
            ? {
                startIso: new Date(Date.UTC(2026, 9, day, 13)).toISOString(),
                endIso: new Date(Date.UTC(2026, 9, day, 19)).toISOString(),
                score: 90,
              }
            : null,
      });
    }
  }
  const card = buildScorecard(emptyRaw({ asOf: "2026-10-13T12:00:00.000Z", hourly }));
  const md = renderMarkdown(card);

  it("counts the censored days and never scores them", () => {
    expect(card.window.ok).toBe(true);
    if (card.window.ok) {
      expect(card.window.result.daysScored).toBe(0);
      expect(card.window.result.skipped.censoredDay).toBe(11);
      expect(card.window.result.skipped.incompleteDay).toBe(1); // the latest day is still going
    }
    expect(card.headlines.window).toContain("collecting — 0 of 10 days");
    expect(card.headlines.window).toContain("11 days left out for missing hours");
  });

  it("never calls a partial day 'the day really had'", () => {
    expect(md).not.toMatch(/really had/i);
    expect(md).toContain("11 censored days (missing hours)");
    expect(md).toContain("archived");
  });
});

describe("buildScorecard — rates show their own count while collecting", () => {
  it("the rain section says n=<count>, collecting for a rate under its own minimum", () => {
    // 60 scored calls, but only 5 are rain calls: hit and false-alarm rates wait.
    const rows: HourlyRow[] = [];
    for (let i = 0; i < 60; i++) {
      const raining = i >= 55;
      for (let h = 0; h < 3; h++) {
        rows.push({
          slug: `b${i}`,
          hour_utc: new Date(Date.UTC(2026, 9, 5, 12 + h)).toISOString(),
          local_date: "2026-10-05",
          local_hour: 8 + h,
          score: 60,
          has_extra: true,
          rain:
            h === 0
              ? { nowcast: raining ? "raining" : "dry", changeInMin: null, radarMmHr: 0, radarDry: 1, radarAgeMin: 5 }
              : { nowcast: null, changeInMin: null, radarMmHr: raining ? 2 : 0, radarDry: raining ? 0 : 1, radarAgeMin: 5 },
        });
      }
    }
    const card = buildScorecard(emptyRaw({ asOf: "2026-10-06T00:00:00.000Z", hourly: rows }));
    const md = renderMarkdown(card);
    expect(card.rain.ok && card.rain.result.ready).toBe(true);
    expect(md).toContain("radar confirmed it n=5, collecting of the time");
    // The headline (55 dry-for-2h calls, none rained on) is published.
    expect(card.headlines.rain).toContain('Of 55 "dry for the next 2+ hrs" calls, 0 (0%) saw radar rain');
  });

  it("the sun call table shows n=<count>, collecting under 10 calls", () => {
    const sun: SunPredictionRow[] = Array.from({ length: 12 }, (_, n) => sunRow(n, n < 3 ? 80 : 30, 40 + n));
    const card = buildScorecard(emptyRaw({ asOf: "2026-12-01T00:00:00.000Z", sunPredictions: sun }));
    expect(renderMarkdown(card)).toContain("n=3, collecting");
  });
});

describe("buildScorecard — sun evaluation window", () => {
  it("shows the window and the lifetime counts when the runner supplies them", () => {
    const card = buildScorecard(
      emptyRaw({
        sunWindowDays: 90,
        sunLifetime: { forecastRows: 5000, forecastEvents: 400, pairedRows: 120, observations: 9, firstArchivedAt: "2026-10-06T15:00:01.514Z" },
      }),
    );
    const md = renderMarkdown(card);
    expect(md).toContain("last 90 days");
    expect(md).toContain("Lifetime: 400 events and 5000 forecast rows logged since 2026-10-06; 120 rows paired; 9 camera readings.");
  });
});

describe("buildScorecard — the fair sun grade", () => {
  /** Event `n` at `slug`, forecast 60 min out, with the truth from `cam`. */
  const row = (n: number, slug: string, kind: "sunrise" | "sunset", score: number, observed: number, cam: string): SunPredictionRow => {
    const eventMs = Date.parse("2026-10-08T10:30:00Z") + n * 86_400_000 + (kind === "sunset" ? 12 * 3_600_000 : 0);
    return {
      slug,
      event_kind: kind,
      event_iso: new Date(eventMs).toISOString(),
      as_of_hour_utc: new Date(eventMs - 3_600_000).toISOString(),
      lead_minutes: 60,
      score,
      band: null,
      algo_version: "2026-10-15.1",
      observed_score: observed,
      observed_source: `sun-cam:${cam}:solar`,
    };
  };
  // Holmes reads everything high, White Sands everything low; the order is right on both.
  const sun = [
    ...Array.from({ length: 12 }, (_, i) => row(i, "anna-maria-island", "sunset", 20 + i * 6, 70 + i * 2, "holmes-beach-cam")),
    ...Array.from({ length: 12 }, (_, i) => row(i, "boca-raton", "sunrise", 95, 5 + i, "deerfield-beach-cam")),
  ];
  const afterglow = Array.from({ length: 12 }, (_, i) => ({
    slug: "boca-raton",
    event_kind: "sunset" as const,
    event_date_local: new Date(Date.parse("2026-10-08T22:30:00Z") + i * 86_400_000).toISOString().slice(0, 10),
    cam_id: "deerfield-beach-cam",
    event_iso: new Date(Date.parse("2026-10-08T22:30:00Z") + i * 86_400_000).toISOString(),
    view: "antisolar",
    observed_score: 50,
    scored_at: "2026-10-30T00:00:00Z",
  }));
  const card = buildScorecard(
    emptyRaw({ asOf: "2026-11-01T00:00:00.000Z", sunPredictions: sun, sunObservations: afterglow }),
    { currentSunVersion: "2026-11-05.1", camFacing: (id) => (id === "holmes-beach-cam" ? "west" : "east") },
  );
  const md = renderMarkdown(card);

  it("puts the live version first, collecting, then the fair grade of the old one", () => {
    expect(card.headlines.sun).toMatch(/^Model 2026-11-05\.1 \(live now\): collecting — 0 of 10 pairs/);
    expect(card.headlines.sun).toContain("Model 2026-10-15.1: 24 pairs; fair rank correlation");
    expect(md).toContain("### The fair grade, by model version");
    expect(md.indexOf("| 2026-11-05.1 (live now) |")).toBeLessThan(md.indexOf("| 2026-10-15.1 |"));
  });

  it("shows the per-cam correlation and the coverage table", () => {
    expect(md).toContain("| 2026-10-15.1 | holmes-beach-cam | Sunset | 12 | +1.00 |");
    // The Deerfield forecast never moved (95 every day): no spread, no correlation.
    expect(md).toContain("| 2026-10-15.1 | deerfield-beach-cam | Sunrise | 12 | no spread |");
    expect(md).toContain("| Sunrise | 12 | 12 | 100% | 12 | 12 | 100% |");
    expect(md).toContain("Each reading counts once, for the beach nearest the cam (Deerfield Beach).");
  });

  it("labels the old tables as raw-scale and lists the fixes from the numbers", () => {
    expect(md).toContain("### Error overall and by group (raw camera scale)");
    expect(md).toContain("### Our call versus what happened (raw camera scale)");
    expect(md).toContain("### What to fix next");
    expect(md).toContain("- Model 2026-10-15.1 runs high when it says Amazing: bias +84.5 points on 12 events (raw camera scale).");
  });

  it("keeps the afterglow apart, in its own section, out of the solar numbers", () => {
    expect(md).toContain("### East-coast sunsets: the afterglow over the ocean");
    expect(md).toContain("### Gulf sunrises: the afterglow over the Gulf");
    // 12 afterglow readings with no forecast event: unmatched, and no sunset pairs appear in the fair grade.
    expect(card.sun.ok && card.sun.result.afterglow?.sunset).toMatchObject({ readings: 12, unmatched: 12 });
    expect(card.sun.ok && card.sun.result.pairedEvents).toBe(24);
  });
});

describe("buildScorecard — cameras hidden as offline", () => {
  const roster = camRoster(LOCATIONS);
  const asOf = "2026-11-06T19:00:00.000Z"; // 2 PM ET
  const raw = emptyRaw({
    asOf,
    camEvidence: [
      { id: "deerfield-spinner-uw", lastGoodFrameAt: null, lastAttempt: { at: "2026-11-06T17:18:10Z", blank: true } },
      { id: "fort-zachary-taylor-cam", lastGoodFrameAt: "2026-11-06T01:08:19Z" },
      { id: "deerfield-pier-cam", lastGoodFrameAt: "2026-11-06T18:30:00Z" },
    ],
    courierNewestGoodAt: "2026-11-06T18:30:00Z",
  });

  it("lists each offline cam with since-when, in the headline and the details", () => {
    const card = buildScorecard(raw, { camRoster: roster });
    expect(card.health.ok).toBe(true);
    if (card.health.ok) {
      expect(card.health.result.camsOffline?.map((c) => c.id)).toEqual(["deerfield-spinner-uw", "fort-zachary-taylor-cam"]);
    }
    expect(card.headlines.health).toContain("2 cameras offline and hidden on the page.");
    const md = renderMarkdown(card);
    expect(md).toContain("- Cameras hidden as offline (they come back on their own with the first good frame): 2");
    expect(md).toContain(
      "  - deerfield-spinner-uw (deerfield-beach): no good frame stored, last try Nov 6, 12:18 PM ET (blank)",
    );
    expect(md).toContain(
      "  - fort-zachary-taylor-cam (key-west): offline since Nov 6, 11:08 AM ET, last good frame Nov 5, 8:08 PM ET",
    );
  });

  it("courier down: says so once instead of listing every courier cam", () => {
    const courierIds = roster.filter((c) => c.cadence.source === "courier").map((c) => c.id);
    const down = emptyRaw({
      asOf,
      camEvidence: [
        ...courierIds.map((id) => ({ id, lastGoodFrameAt: "2026-11-06T13:00:00Z" as string | null })),
        { id: "boca-south", lastGoodFrameAt: "2026-11-06T18:40:00Z" },
      ],
      courierNewestGoodAt: "2026-11-06T13:00:00Z", // 8 AM ET
    });
    const card = buildScorecard(down, { camRoster: roster });
    expect(card.headlines.health).toContain("The home-server courier is down since Nov 6, 10:00 AM ET.");
    expect(card.headlines.health).not.toContain("offline and hidden");
    const md = renderMarkdown(card);
    expect(md).toContain("- Courier down since Nov 6, 10:00 AM ET (newest courier frame Nov 6, 8:00 AM ET)");
    expect(md).toContain("- Cameras hidden as offline: none.");
  });

  it("courier down with a camera that has no good frame: that one is still listed, and the wording says so", () => {
    const courierIds = roster.filter((c) => c.cadence.source === "courier").map((c) => c.id);
    const mixed = emptyRaw({
      asOf,
      camEvidence: courierIds.map((id) => ({
        id,
        lastGoodFrameAt: (id === "deerfield-spinner-uw" ? null : "2026-11-06T13:00:00Z") as string | null,
      })),
      courierNewestGoodAt: "2026-11-06T13:00:00Z",
    });
    const card = buildScorecard(mixed, { camRoster: roster });
    expect(card.health.ok && card.health.result.camsOffline?.map((c) => c.id)).toEqual(["deerfield-spinner-uw"]);
    const md = renderMarkdown(card);
    expect(md).toContain("its cameras that only went quiet stay on the page");
    expect(md).toContain("(a camera with no good frame stored is still hidden)");
    expect(md).toContain("  - deerfield-spinner-uw (deerfield-beach): no good frame stored");
  });

  it("says none, or not checked, plainly", () => {
    const none = renderMarkdown(buildScorecard(emptyRaw({ asOf, camEvidence: [] }), { camRoster: roster }));
    expect(none).toContain("- Cameras hidden as offline: none.");
    const old = renderMarkdown(buildScorecard(emptyRaw({ asOf }), { camRoster: roster }));
    expect(old).toContain("- Cameras hidden as offline: not checked.");
  });
});
