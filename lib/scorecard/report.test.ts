import { describe, expect, it } from "vitest";
import { buildScorecard, renderMarkdown, type RawData } from "@/lib/scorecard/report";
import type { HourlyRow, SunPredictionRow } from "@/lib/scorecard/metrics";

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
    expect(card.headlines.safety).toContain("collecting — 0 of 50 hours");
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
  // Safety: 60 hours with a green or yellow flag (yellow -> we said caution, green -> safe: all agree),
  // then 6 hours under a red flag (we said stay out). Red hours must not count toward agreement.
  const flagHour = (date: string, hour: number, color: string, swim: string) => {
    const r = hourly.find((x) => x.local_date === date && x.local_hour === hour)!;
    r.flags = { colors: [color] };
    r.safety = { swim };
  };
  for (let hour = 0; hour < 24; hour++) {
    for (const date of ["2026-10-04", "2026-10-05"]) {
      flagHour(date, hour, hour % 2 ? "yellow" : "green", hour % 2 ? "caution" : "safe");
    }
  }
  for (let hour = 0; hour < 12; hour++) flagHour("2026-10-06", hour, hour % 2 ? "yellow" : "green", hour % 2 ? "caution" : "safe");
  for (let hour = 12; hour < 18; hour++) flagHour("2026-10-06", hour, "red", "stay-out");

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

  it("sun: reports error numbers once there are 10 pairs", () => {
    expect(card.sun.ok && card.sun.result.ready).toBe(true);
    expect(card.headlines.sun).toContain("12 pairs");
    expect(card.headlines.sun).toContain("Typical miss 10.0 points");
    expect(card.headlines.sun).toContain("bias +10.0");
  });

  it("sun: counts a camera reading with no forecast, and matches within 15 minutes", () => {
    expect(card.sun.ok && card.sun.result.observations).toBe(2);
    expect(card.sun.ok && card.sun.result.observationsWithoutForecast).toBe(1);
  });

  it("rain: the headline is the 'dry for 2+ hrs' promise", () => {
    // Rows of days 0-2 are calls (72); scored when +1 h and +2 h radar exist (the last 2 rows of day 2 have none).
    expect(card.rain.ok && card.rain.result.ready).toBe(true);
    // Rain showed at day 0 hour 10: the dry calls made at hours 8 and 9 (and hour 10's own row has radar at 11, 12: dry) were rained on.
    expect(card.headlines.rain).toMatch(/Of 70 "dry for the next 2\+ hrs" calls, 2 \(3%\) saw radar rain within 2 hours\./);
  });

  it("window: 10+ finished days score the window against the realized hours", () => {
    expect(card.window.ok && card.window.result.ready).toBe(true);
    expect(card.headlines.window).toContain("day");
    if (card.window.ok) {
      expect(card.window.result.realizedInWindow).toBe(60);
      expect(card.window.result.realizedBest3h).toBe(60);
      expect(card.window.result.gapPts).toBe(0);
      expect(card.window.result.windowScoreBias).toBe(4);
    }
  });

  it("safety: excludes red hours from the agreement rate", () => {
    expect(card.safety.ok && card.safety.result.ready).toBe(true);
    if (card.safety.ok) {
      expect(card.safety.result.hours).toBe(66);
      expect(card.safety.result.informative.hours).toBe(60);
    }
    expect(card.headlines.safety).toContain("our swim message agreed with the flag 100%");
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
    expect(md).toContain("### Swim message by flag (hours)");
    expect(md).toContain("### Green and yellow flags only");
    expect(md).not.toContain("NaN");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("collecting —  ");
  });
});
