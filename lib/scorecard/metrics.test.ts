import { describe, expect, it } from "vitest";
import {
  collectingText,
  dataHealth,
  dominantFlag,
  leadBucketOf,
  radarRainAt,
  rainMetrics,
  safetyMetrics,
  sunBandOf,
  sunColorMetrics,
  windowMetrics,
  type HealthRow,
  type HourlyRow,
  type RainBlock,
  type RainRow,
  type SafetyRow,
  type SunPredictionRow,
  type WindowRow,
} from "@/lib/scorecard/metrics";

// --- Sun color fixtures -----------------------------------------------------

const EVENT_BASE = Date.parse("2026-10-10T10:30:00Z");

/** One forecast row for event number `n` at a given lead, made `lead` minutes before the event. */
function pred(
  n: number,
  leadMin: number,
  score: number | null,
  observed: number | null,
  over: Partial<SunPredictionRow> = {},
): SunPredictionRow {
  const eventMs = EVENT_BASE + n * 86_400_000;
  const asOf = Math.floor((eventMs - leadMin * 60_000) / 3_600_000) * 3_600_000;
  return {
    slug: "boca-raton",
    event_kind: "sunrise",
    event_iso: new Date(eventMs).toISOString(),
    as_of_hour_utc: new Date(asOf).toISOString(),
    lead_minutes: leadMin,
    score,
    band: score == null ? null : sunBandOf(score),
    algo_version: "2026-10-06.2",
    observed_score: observed,
    observed_source: observed == null ? null : "sun-cam:test:solar",
    ...over,
  };
}

describe("collectingText", () => {
  it("uses the exact wording the report shows", () => {
    expect(collectingText(3, 10, "pairs")).toBe("collecting — 3 of 10 pairs");
  });
});

describe("sunBandOf / leadBucketOf", () => {
  it("uses the lib/sunQuality.ts band cutoffs", () => {
    expect(sunBandOf(0)).toBe("dud");
    expect(sunBandOf(19)).toBe("dud");
    expect(sunBandOf(20)).toBe("plain");
    expect(sunBandOf(44)).toBe("plain");
    expect(sunBandOf(45)).toBe("good");
    expect(sunBandOf(69)).toBe("good");
    expect(sunBandOf(70)).toBe("vivid");
    expect(sunBandOf(89)).toBe("vivid");
    expect(sunBandOf(90)).toBe("epic");
    expect(sunBandOf(100)).toBe("epic");
  });

  it("buckets lead minutes at the edges", () => {
    expect(leadBucketOf(-30)).toBe("<0");
    expect(leadBucketOf(0)).toBe("0–2h");
    expect(leadBucketOf(119)).toBe("0–2h");
    expect(leadBucketOf(120)).toBe("2–6h");
    expect(leadBucketOf(359)).toBe("2–6h");
    expect(leadBucketOf(360)).toBe("6–12h");
    expect(leadBucketOf(719)).toBe("6–12h");
    expect(leadBucketOf(720)).toBe("12–24h");
    expect(leadBucketOf(1439)).toBe("12–24h");
    expect(leadBucketOf(1440)).toBe(">24h");
    expect(leadBucketOf(5000)).toBe(">24h");
  });
});

describe("sunColorMetrics — not enough data", () => {
  it("empty input reports collecting and no error numbers", () => {
    const r = sunColorMetrics([]);
    expect(r.ready).toBe(false);
    expect(r.collecting).toBe("collecting — 0 of 10 pairs");
    expect(r.overall.mae).toBeNull();
    expect(r.overall.bias).toBeNull();
    expect(r.calls.ready).toBe(false);
    expect(r.calls.great.hitRate).toBeNull();
  });

  it("counts events, not rows, against the minimum", () => {
    // One event with 30 hourly forecast rows is ONE pair, not thirty.
    const rows = Array.from({ length: 30 }, (_, i) => pred(0, 30 * 60 - i * 60, 60, 80));
    const r = sunColorMetrics(rows);
    expect(r.pairedEvents).toBe(1);
    expect(r.pairedRows).toBe(30);
    expect(r.collecting).toBe("collecting — 1 of 10 pairs");
    expect(r.overall.mae).toBeNull();
    expect(r.overall.events).toBe(1);
    expect(r.overall.rows).toBe(30);
  });

  it("unpaired rows (no observation yet) are not pairs", () => {
    const r = sunColorMetrics([pred(0, 600, 70, null), pred(1, 600, 55, null)]);
    expect(r.events).toBe(2);
    expect(r.pairedEvents).toBe(0);
    expect(r.collecting).toBe("collecting — 0 of 10 pairs");
  });

  it("rows with no score (no forecast) are ignored", () => {
    const r = sunColorMetrics([pred(0, 600, null, 80)]);
    expect(r.events).toBe(0);
    expect(r.pairedEvents).toBe(0);
  });
});

describe("sunColorMetrics — error numbers", () => {
  // 12 events; each has one 10-hour-lead row and one 3-hour-lead row.
  // 10 h row: predicted = observed + 10 (bias +10). 3 h row: predicted = observed - 4.
  const rows: SunPredictionRow[] = [];
  for (let n = 0; n < 12; n++) {
    const obs = 40 + n * 3; // 40..73
    rows.push(pred(n, 600, obs + 10, obs));
    rows.push(pred(n, 180, obs - 4, obs));
  }
  const r = sunColorMetrics(rows);

  it("is ready at 12 paired events", () => {
    expect(r.ready).toBe(true);
    expect(r.collecting).toBeNull();
    expect(r.pairedEvents).toBe(12);
    expect(r.pairedRows).toBe(24);
  });

  it("overall MAE and bias are predicted − observed", () => {
    // errors: +10 x12, -4 x12  => MAE (120+48)/24 = 7, bias (120-48)/24 = 3
    expect(r.overall.mae).toBe(7);
    expect(r.overall.bias).toBe(3);
  });

  it("by lead bucket", () => {
    const b = Object.fromEntries(r.byLead.map((g) => [g.key, g]));
    expect(b["6–12h"].mae).toBe(10);
    expect(b["6–12h"].bias).toBe(10);
    expect(b["2–6h"].mae).toBe(4);
    expect(b["2–6h"].bias).toBe(-4);
    expect(r.byLead.map((g) => g.key)).toEqual(["2–6h", "6–12h"]); // canonical order, only buckets with data
  });

  it("by algo version and by beach", () => {
    expect(r.byAlgo).toHaveLength(1);
    expect(r.byAlgo[0].key).toBe("2026-10-06.2");
    expect(r.byBeach).toHaveLength(1);
    expect(r.byBeach[0].key).toBe("boca-raton");
    expect(r.byBeach[0].events).toBe(12);
  });

  it("by predicted band, gating each group on its own events", () => {
    // Predicted scores: 10 h row 50..83, 3 h row 36..69. Bands mix, so some groups are small.
    const total = r.byBand.reduce((s, g) => s + g.rows, 0);
    expect(total).toBe(24);
    for (const g of r.byBand) {
      if (g.events < 10) {
        expect(g.mae).toBeNull();
        expect(g.collecting).toBe(`collecting — ${g.events} of 10 pairs`);
      } else {
        expect(g.mae).not.toBeNull();
      }
    }
    // Every row's band follows its predicted score.
    expect(r.byBand.map((g) => g.key)).toEqual(["plain", "good", "vivid"]);
  });

  it("splits by beach and algo when they differ, and gates small groups", () => {
    const mixed = [
      ...rows,
      pred(20, 300, 50, 60, { slug: "deerfield-beach", algo_version: "2026-11-01.1" }),
    ];
    const m = sunColorMetrics(mixed);
    const deer = m.byBeach.find((g) => g.key === "deerfield-beach")!;
    expect(deer.events).toBe(1);
    expect(deer.mae).toBeNull();
    expect(deer.collecting).toBe("collecting — 1 of 10 pairs");
    expect(m.byAlgo.map((g) => g.key)).toEqual(["2026-10-06.2", "2026-11-01.1"]);
    // The big group is still reported.
    expect(m.byBeach[0].key).toBe("boca-raton");
    expect(m.byBeach[0].mae).not.toBeNull();
  });

  it("falls back to the score's own band when the row has none", () => {
    const noBand = rows.map((x) => ({ ...x, band: null }));
    expect(sunColorMetrics(noBand).byBand.map((g) => g.key)).toEqual(["plain", "good", "vivid"]);
  });
});

describe("sunColorMetrics — camera view and future events", () => {
  it("keeps cams that look at the sun apart from cams that look away", () => {
    const rows: SunPredictionRow[] = [];
    for (let n = 0; n < 10; n++) rows.push(pred(n, 120, 60, 70, { observed_source: "sun-cam:a:solar" }));
    for (let n = 10; n < 12; n++) rows.push(pred(n, 120, 60, 70, { observed_source: "sun-cam:b:antisolar" }));
    rows.push(pred(12, 120, 60, 70, { observed_source: "by-hand" }));
    const r = sunColorMetrics(rows);
    const v = Object.fromEntries(r.byView.map((g) => [g.key, g]));
    expect(v.solar.events).toBe(10);
    expect(v.solar.mae).toBe(10);
    expect(v.antisolar.events).toBe(2);
    expect(v.antisolar.mae).toBeNull();
    expect(v.other.events).toBe(1);
  });

  it("with nowMs, events that have not happened yet stay out of the distribution", () => {
    const rows = [pred(0, 600, 80, null), pred(1, 600, 80, null), pred(2, 600, 20, null)];
    const nowMs = EVENT_BASE + 1.5 * 86_400_000; // after events 0 and 1, before event 2
    const r = sunColorMetrics(rows, { min: 1, nowMs });
    expect(r.distribution.overall.allEvents).toBe(2);
    expect(r.distribution.overall.predGreatAll).toBe(1);
    // Without nowMs all three count.
    expect(sunColorMetrics(rows, { min: 1 }).distribution.overall.allEvents).toBe(3);
  });
});

describe("sunColorMetrics — the call analysis", () => {
  // 12 paired events. The call is the LATEST row with lead >= 60 min.
  // Each event also has an 'after' row (lead 30) that must never count as the call.
  const spec: { pred: number; obs: number }[] = [
    { pred: 85, obs: 80 }, // hit @70
    { pred: 75, obs: 72 }, // hit @70
    { pred: 72, obs: 40 }, // false alarm @70
    { pred: 91, obs: 93 }, // hit @70, hit @90
    { pred: 92, obs: 60 }, // false alarm @70 and @90
    { pred: 50, obs: 85 }, // miss @70
    { pred: 60, obs: 71 }, // miss @70
    { pred: 40, obs: 30 }, // correct negative
    { pred: 30, obs: 20 }, // correct negative
    { pred: 65, obs: 50 }, // correct negative
    { pred: 20, obs: 95 }, // miss @70 and @90
    { pred: 10, obs: 5 }, // correct negative
  ];
  const rows: SunPredictionRow[] = [];
  spec.forEach((s, n) => {
    rows.push(pred(n, 720, 99, s.obs)); // earlier, ignored: a later row with lead >= 60 exists
    rows.push(pred(n, 120, s.pred, s.obs)); // the call
    rows.push(pred(n, 30, s.obs, s.obs)); // too close to the event: never the call
  });
  const r = sunColorMetrics(rows);

  it("picks the latest forecast made at least 60 minutes ahead", () => {
    expect(r.calls.events).toBe(12);
    expect(r.calls.ready).toBe(true);
  });

  it("Great cutoff (70)", () => {
    expect(r.calls.great).toMatchObject({
      cutoff: 70,
      hits: 3,
      falseAlarms: 2,
      misses: 3,
      correctNegatives: 4,
      calls: 5,
      observedAtOrAbove: 6,
    });
    expect(r.calls.great.hitRate).toBeCloseTo(3 / 5);
    expect(r.calls.great.falseAlarmRate).toBeCloseTo(2 / 5);
    expect(r.calls.great.missRate).toBeCloseTo(3 / 6);
  });

  it("Amazing cutoff (90)", () => {
    expect(r.calls.amazing).toMatchObject({
      cutoff: 90,
      hits: 1,
      falseAlarms: 1,
      misses: 1,
      correctNegatives: 9,
    });
    expect(r.calls.amazing.hitRate).toBeCloseTo(0.5);
    expect(r.calls.amazing.missRate).toBeCloseTo(0.5);
  });

  it("the call counts are visible even while collecting, but rates are not", () => {
    const few = sunColorMetrics(rows.slice(0, 9)); // first 3 events
    expect(few.calls.ready).toBe(false);
    expect(few.calls.collecting).toBe("collecting — 3 of 10 pairs");
    expect(few.calls.great.hits).toBe(2);
    expect(few.calls.great.hitRate).toBeNull();
    expect(few.calls.great.missRate).toBeNull();
  });

  it("an event with no forecast made >= 60 minutes ahead has no call", () => {
    const late = sunColorMetrics([pred(0, 30, 80, 80), pred(0, -10, 80, 80)]);
    expect(late.pairedEvents).toBe(1);
    expect(late.calls.events).toBe(0);
  });

  it("does not divide by zero when nothing was called", () => {
    const none = sunColorMetrics(Array.from({ length: 10 }, (_, n) => pred(n, 120, 30, 30)));
    expect(none.calls.ready).toBe(true);
    expect(none.calls.great.calls).toBe(0);
    expect(none.calls.great.hitRate).toBeNull();
    expect(none.calls.great.falseAlarmRate).toBeNull();
    expect(none.calls.great.missRate).toBeNull();
  });
});

describe("sunColorMetrics — predicted vs observed distribution", () => {
  it("compares the share at Great+ / Amazing with the design target", () => {
    const rows: SunPredictionRow[] = [];
    // 10 paired events at boca: predicted 72, 95, then 8 low; observed 80, 60, 91, then 7 low.
    const predicted = [72, 95, 40, 40, 40, 40, 40, 40, 40, 40];
    const observed = [80, 60, 91, 30, 30, 30, 30, 30, 30, 30];
    predicted.forEach((p, n) => rows.push(pred(n, 120, p, observed[n])));
    // 3 more unpaired boca events, one Great+; and 1 deerfield unpaired.
    rows.push(pred(20, 120, 75, null), pred(21, 120, 10, null), pred(22, 120, 10, null));
    rows.push(pred(23, 120, 10, null, { slug: "deerfield-beach" }));
    const r = sunColorMetrics(rows);
    expect(r.distribution.target).toEqual({ great: 0.2, amazing: 0.1 });
    const boca = r.distribution.byBeach.find((d) => d.key === "boca-raton")!;
    expect(boca.allEvents).toBe(13);
    expect(boca.pairedEvents).toBe(10);
    expect(boca.predGreatPaired).toBeCloseTo(0.2); // 72, 95
    expect(boca.predAmazingPaired).toBeCloseTo(0.1); // 95
    expect(boca.obsGreat).toBeCloseTo(0.2); // 80, 91
    expect(boca.obsAmazing).toBeCloseTo(0.1); // 91
    expect(boca.predGreatAll).toBeCloseTo(3 / 13); // adds the unpaired 75
    // The beach with one event reports no shares.
    const deer = r.distribution.byBeach.find((d) => d.key === "deerfield-beach")!;
    expect(deer.allEvents).toBe(1);
    expect(deer.predGreatAll).toBeNull();
    expect(deer.obsGreat).toBeNull();
    expect(r.distribution.overall.allEvents).toBe(14);
  });
});

// --- Rain fixtures ----------------------------------------------------------

const H0 = Date.parse("2026-10-10T12:00:00Z");
const hourIso = (i: number) => new Date(H0 + i * 3_600_000).toISOString();
const rainRow = (i: number, rain: RainBlock | null, slug = "boca-raton"): RainRow => ({
  slug,
  hour_utc: hourIso(i),
  rain,
});
const call = (nowcast: "dry" | "raining", over: Partial<RainBlock> = {}): RainBlock => ({
  nowcast,
  radarMmHr: 0,
  radarDry: 1,
  changeInMin: null,
  radarAgeMin: 5,
  ...over,
});
const wet: RainBlock = { nowcast: null, radarMmHr: 2, radarDry: 0, radarAgeMin: 5 };
const dry: RainBlock = { nowcast: null, radarMmHr: 0, radarDry: 1, radarAgeMin: 5 };

describe("radarRainAt", () => {
  it("rain when a fresh frame is not confident-dry, or the rate is over the threshold", () => {
    expect(radarRainAt({ nowcast: null, radarMmHr: 0, radarDry: 0, radarAgeMin: 5 })).toBe(true);
    expect(radarRainAt({ nowcast: null, radarMmHr: 0.3, radarDry: null, radarAgeMin: 5 })).toBe(true);
  });
  it("dry when confident-dry, or a fresh zero rate", () => {
    expect(radarRainAt({ nowcast: null, radarMmHr: 0, radarDry: 1, radarAgeMin: 5 })).toBe(false);
    expect(radarRainAt({ nowcast: null, radarMmHr: 0, radarDry: null, radarAgeMin: 5 })).toBe(false);
  });
  it("unknown without a usable radar reading", () => {
    expect(radarRainAt(null)).toBeNull();
    expect(radarRainAt({ nowcast: null, radarMmHr: null, radarDry: null })).toBeNull();
    // A stale frame is not a current observation, even if it showed rain.
    expect(radarRainAt({ nowcast: null, radarMmHr: 4, radarDry: null, radarAgeMin: 40 })).toBeNull();
    expect(radarRainAt({ nowcast: null, radarMmHr: 0, radarDry: null, radarAgeMin: 40 })).toBeNull();
  });
  it("honours a custom threshold", () => {
    const r = { nowcast: null, radarMmHr: 0.3, radarDry: null, radarAgeMin: 5 } as const;
    expect(radarRainAt(r, 0.5)).toBe(false);
    expect(radarRainAt(r, 0.1)).toBe(true);
  });
});

describe("rainMetrics", () => {
  it("empty input is collecting", () => {
    const r = rainMetrics([]);
    expect(r.scored).toBe(0);
    expect(r.ready).toBe(false);
    expect(r.collecting).toBe("collecting — 0 of 50 scored calls");
    expect(r.next2h.dryRainedOnRate).toBeNull();
    expect(r.dryPromise.rate).toBeNull();
  });

  it("scores a nowcast against radar at +1 h and +2 h", () => {
    // Call at hour 0 (dry). Radar: +1 dry, +2 wet -> rain within 2 h, not within 1 h.
    const r = rainMetrics([rainRow(0, call("dry")), rainRow(1, dry), rainRow(2, wet)], { min: 1 });
    expect(r.scored).toBe(1);
    expect(r.next1h).toMatchObject({ misses: 0, correctDry: 1 });
    expect(r.next2h).toMatchObject({ misses: 1, correctDry: 0 });
    expect(r.next2h.dryRainedOnRate).toBe(1);
    expect(r.dryPromise).toEqual({ n: 1, rainedOn: 1, rate: 1 });
  });

  it("needs radar truth at BOTH +1 h and +2 h", () => {
    const missing2 = rainMetrics([rainRow(0, call("dry")), rainRow(1, dry)], { min: 1 });
    expect(missing2.calls).toBe(1);
    expect(missing2.scored).toBe(0);
    const unknown1 = rainMetrics(
      [rainRow(0, call("dry")), rainRow(1, { nowcast: null, radarMmHr: null, radarDry: null }), rainRow(2, dry)],
      { min: 1 },
    );
    expect(unknown1.scored).toBe(0);
  });

  it("builds the confusion matrix and the three rates", () => {
    // Each call gets its own beach so the rows never interact.
    const rows: RainRow[] = [];
    const add = (slug: string, c: RainBlock, r1: RainBlock, r2: RainBlock) => {
      rows.push(rainRow(0, c, slug), rainRow(1, r1, slug), rainRow(2, r2, slug));
    };
    // 4 "raining" calls: 3 followed by rain, 1 not.
    add("a", call("raining"), wet, wet);
    add("b", call("raining"), wet, dry);
    add("c", call("raining"), dry, wet);
    add("d", call("raining"), dry, dry);
    // 6 "dry" calls: 2 rained on within 2 h, 4 stayed dry.
    add("e", call("dry"), wet, dry);
    add("f", call("dry"), dry, wet);
    add("g", call("dry"), dry, dry);
    add("h", call("dry"), dry, dry);
    add("i", call("dry"), dry, dry);
    add("j", call("dry"), dry, dry);
    const r = rainMetrics(rows, { min: 10 });
    expect(r.scored).toBe(10);
    expect(r.ready).toBe(true);
    expect(r.next2h).toMatchObject({ hits: 3, falseAlarms: 1, misses: 2, correctDry: 4, rainCalls: 4, dryCalls: 6 });
    expect(r.next2h.hitRate).toBeCloseTo(3 / 4);
    expect(r.next2h.falseAlarmRate).toBeCloseTo(1 / 4);
    expect(r.next2h.missRate).toBeCloseTo(2 / 5); // 5 rain cases, 2 called dry
    expect(r.next2h.dryRainedOnRate).toBeCloseTo(2 / 6);
    // Next hour only: rain at +1 h is wet for a, b, e only.
    expect(r.next1h).toMatchObject({ hits: 2, falseAlarms: 2, misses: 1, correctDry: 5 });
  });

  it("holds rates back below the minimum but still shows the counts", () => {
    const r = rainMetrics([rainRow(0, call("dry")), rainRow(1, dry), rainRow(2, wet)]);
    expect(r.ready).toBe(false);
    expect(r.next2h.misses).toBe(1);
    expect(r.next2h.dryRainedOnRate).toBeNull();
    expect(r.dryPromise.rate).toBeNull();
    expect(r.dryPromise.rainedOn).toBe(1);
  });

  it("the headline only counts 'dry for 2+ hrs' calls, not 'dry, rain in 25 min'", () => {
    const rows = [
      // dry with rain expected in 25 min, and it rained: a correct call, not a broken promise
      rainRow(0, call("dry", { changeInMin: 25 }), "a"),
      rainRow(1, wet, "a"),
      rainRow(2, wet, "a"),
      // dry for 2+ hrs, and it stayed dry
      rainRow(0, call("dry"), "b"),
      rainRow(1, dry, "b"),
      rainRow(2, dry, "b"),
      // dry for 2+ hrs, and it rained
      rainRow(0, call("dry"), "c"),
      rainRow(1, dry, "c"),
      rainRow(2, wet, "c"),
    ];
    const r = rainMetrics(rows, { min: 3 });
    expect(r.next2h.dryCalls).toBe(3);
    expect(r.dryPromise).toEqual({ n: 2, rainedOn: 1, rate: 0.5 });
  });

  it("does not mix beaches when looking up the next hours", () => {
    const rows = [rainRow(0, call("dry"), "a"), rainRow(1, wet, "b"), rainRow(2, wet, "b")];
    expect(rainMetrics(rows, { min: 1 }).scored).toBe(0);
  });

  it("a stale radar frame is not scored as truth", () => {
    const stale: RainBlock = { nowcast: null, radarMmHr: 0, radarDry: null, radarAgeMin: 90 };
    expect(rainMetrics([rainRow(0, call("dry")), rainRow(1, stale), rainRow(2, dry)], { min: 1 }).scored).toBe(0);
  });

  it("rows without a nowcast are not calls", () => {
    const r = rainMetrics([rainRow(0, wet), rainRow(1, dry), rainRow(2, dry), rainRow(3, null)], { min: 1 });
    expect(r.calls).toBe(0);
  });
});

// --- Window fixtures --------------------------------------------------------

/** UTC hour for a local hour on `date` in a UTC-4 beach. */
const utcOf = (date: string, hour: number) => new Date(Date.parse(`${date}T00:00:00Z`) + (hour + 4) * 3_600_000).toISOString();

interface DaySpec {
  slug?: string;
  date: string;
  /** realized score by local hour (all of 7..18 are filled from this) */
  scores: Record<number, number>;
  /** window predicted at `predictedAtHour` */
  window?: { start: number; end: number; score: number; predictedAtHour?: number } | null;
  outlook?: { date: string; peak: number }[];
}

function dayRows(s: DaySpec): WindowRow[] {
  const slug = s.slug ?? "boca-raton";
  const rows: WindowRow[] = [];
  for (let h = 0; h < 24; h++) {
    const score = s.scores[h] ?? null;
    const isPredictionHour = s.window && h === (s.window.predictedAtHour ?? 8);
    rows.push({
      slug,
      local_date: s.date,
      local_hour: h,
      hour_utc: utcOf(s.date, h),
      score,
      window:
        isPredictionHour && s.window
          ? { startIso: utcOf(s.date, s.window.start), endIso: utcOf(s.date, s.window.end), score: s.window.score }
          : null,
      outlook: h === (s.window?.predictedAtHour ?? 8) && s.outlook ? { days: s.outlook } : null,
    });
  }
  return rows;
}

/** A trailing row on a later date, so the earlier day counts as finished. */
const closer = (date: string, slug = "boca-raton"): WindowRow => ({
  slug,
  local_date: date,
  local_hour: 0,
  hour_utc: utcOf(date, 0),
  score: 50,
  window: null,
});

/** Hours 7..18 all at `base`, with overrides. */
const flat = (base: number, over: Record<number, number> = {}): Record<number, number> => {
  const o: Record<number, number> = {};
  for (let h = 7; h < 19; h++) o[h] = base;
  return { ...o, ...over };
};

describe("windowMetrics", () => {
  it("empty input is collecting", () => {
    const r = windowMetrics([]);
    expect(r.ready).toBe(false);
    expect(r.collecting).toBe("collecting — 0 of 10 days");
    expect(r.gapPts).toBeNull();
    expect(r.outlook).toEqual([]);
  });

  it("scores one day: window mean, best 3 h, peak inside, within 10", () => {
    // Realized: 60 everywhere, 90 at hours 12-14. Window predicted 11:00-16:00 (hours 11..15), score 85.
    // In window: 60, 90, 90, 90, 60 => mean 78. Best 3 h = 90. Gap 12. Peak (90) is inside. |85-78| = 7 <= 10.
    const rows = [
      ...dayRows({
        date: "2026-10-10",
        scores: flat(60, { 12: 90, 13: 90, 14: 90 }),
        window: { start: 11, end: 16, score: 85 },
      }),
      closer("2026-10-11"),
    ];
    const r = windowMetrics(rows, { min: 1 });
    expect(r.daysScored).toBe(1);
    expect(r.ready).toBe(true);
    expect(r.realizedInWindow).toBe(78);
    expect(r.realizedBest3h).toBe(90);
    expect(r.gapPts).toBe(12);
    expect(r.peakInWindowShare).toBe(1);
    expect(r.within10Share).toBe(1);
    expect(r.windowScoreBias).toBe(7);
    expect(r.meanWindowHours).toBe(5);
    expect(r.meanPredictedAtHour).toBe(8);
  });

  it("a day where the realized peak was outside the window and the score was far off", () => {
    // Window 7..10 (hours 7,8,9) at score 90, but the day scored 50 there and peaked at 80 at 17:00.
    const rows = [
      ...dayRows({
        date: "2026-10-10",
        scores: flat(50, { 17: 80 }),
        window: { start: 7, end: 10, score: 90, predictedAtHour: 6 },
      }),
      closer("2026-10-11"),
    ];
    const r = windowMetrics(rows, { min: 1 });
    expect(r.peakInWindowShare).toBe(0);
    expect(r.within10Share).toBe(0);
    expect(r.realizedInWindow).toBe(50);
    expect(r.realizedBest3h).toBeCloseTo(((50 + 50 + 80) / 3) * 1, 1); // hours 16,17,18 => 60
    expect(r.windowScoreBias).toBe(40);
    expect(r.meanPredictedAtHour).toBe(6);
  });

  it("uses the EARLIEST window at or before 10 AM, never a later one", () => {
    const rows = dayRows({ date: "2026-10-10", scores: flat(60), window: { start: 9, end: 12, score: 60, predictedAtHour: 5 } });
    // A second, later prediction (hour 9) that disagrees; a third AFTER 10 AM that must be ignored.
    const later = dayRows({ date: "2026-10-10", scores: flat(60), window: { start: 14, end: 17, score: 99, predictedAtHour: 9 } });
    rows.push(...later.filter((r) => r.local_hour === 9));
    const late = dayRows({ date: "2026-10-10", scores: flat(60), window: { start: 14, end: 17, score: 99, predictedAtHour: 11 } });
    rows.push(...late.filter((r) => r.local_hour === 11));
    rows.push(closer("2026-10-11"));
    const r = windowMetrics(rows, { min: 1 });
    expect(r.meanPredictedAtHour).toBe(5);
    expect(r.windowScoreBias).toBe(0); // score 60 vs realized 60 in window 9..12
  });

  it("skips days that are not finished, thin, or have no early window — and says so", () => {
    const rows = [
      // finished but with only 5 daylight hours
      ...dayRows({ date: "2026-10-09", scores: { 9: 60, 10: 60, 11: 60, 12: 60, 13: 60 }, window: { start: 9, end: 14, score: 60 } }),
      // full day but no window ever archived by 10 AM
      ...dayRows({ date: "2026-10-10", scores: flat(60), window: null }),
      // full day, window — but the day is still going (nothing later archived)
      ...dayRows({ date: "2026-10-11", scores: flat(60), window: { start: 9, end: 14, score: 60 } }),
      closer("2026-10-11"), // closes 10-10 only; 10-11 has its own rows on that date, so it is the last date
    ];
    const r = windowMetrics(rows, { min: 1 });
    expect(r.daysScored).toBe(0);
    expect(r.skipped.tooFewHours).toBe(1);
    expect(r.skipped.noEarlyWindow).toBe(1);
    expect(r.skipped.incompleteDay).toBe(1);
  });

  it("only daylight hours count; night scores are ignored", () => {
    // Night hours 0..6 and 19..23 score 100 and would dominate if counted.
    const scores = { ...flat(50), 0: 100, 1: 100, 2: 100, 3: 100, 22: 100, 23: 100 };
    const rows = [...dayRows({ date: "2026-10-10", scores, window: { start: 9, end: 12, score: 50 } }), closer("2026-10-11")];
    const r = windowMetrics(rows, { min: 1 });
    expect(r.realizedBest3h).toBe(50);
  });

  it("takes daylight bounds from the caller when given", () => {
    const rows = [
      ...dayRows({ date: "2026-10-10", scores: { ...flat(50), 6: 100, 7: 100, 8: 100 }, window: { start: 9, end: 12, score: 50 } }),
      closer("2026-10-11"),
    ];
    // Daylight 6..18: the three high hours now count.
    const r = windowMetrics(rows, { min: 1, daylight: () => ({ from: 6, to: 19 }) });
    expect(r.realizedBest3h).toBe(100);
    // A beach with unknown daylight is skipped, not guessed.
    const none = windowMetrics(rows, { min: 1, daylight: () => null });
    expect(none.daysScored).toBe(0);
  });

  it("gaps in the archive break the contiguous 3-hour run", () => {
    // 90 at hours 10, 12, 14 with 50 between: the best run is 90, 50, 90.
    const scores = flat(50, { 10: 90, 12: 90, 14: 90 });
    const rows = [...dayRows({ date: "2026-10-10", scores, window: { start: 9, end: 16, score: 90 } }), closer("2026-10-11")];
    expect(windowMetrics(rows, { min: 1 }).realizedBest3h).toBeCloseTo((90 + 50 + 90) / 3, 1);

    // Hour 10 was never archived. Hours 9 and 11 are NOT neighbours, so [9, 11, 12]
    // (90, 90, 50) must not be read as a run; the best real run is 63.3.
    const gappy = { 7: 50, 8: 50, 9: 90, 11: 90, 12: 50, 13: 50, 14: 50, 15: 50 };
    const rows2 = [...dayRows({ date: "2026-10-10", scores: gappy, window: { start: 9, end: 16, score: 90 } }), closer("2026-10-11")];
    expect(windowMetrics(rows2, { min: 1 }).realizedBest3h).toBeCloseTo((50 + 50 + 90) / 3, 1);
  });

  it("holds numbers back below the minimum of 10 days", () => {
    const rows: WindowRow[] = [];
    for (let d = 1; d <= 5; d++) {
      const date = `2026-10-0${d}`;
      rows.push(...dayRows({ date, scores: flat(60), window: { start: 9, end: 14, score: 60 } }));
    }
    rows.push(closer("2026-10-06"));
    const r = windowMetrics(rows);
    expect(r.daysScored).toBe(5);
    expect(r.ready).toBe(false);
    expect(r.collecting).toBe("collecting — 5 of 10 days");
    expect(r.gapPts).toBeNull();
    expect(r.peakInWindowShare).toBeNull();
  });

  it("outlook: peak promised N days ahead vs the realized peak, by lead day", () => {
    // Archived 10-10 morning: promises 10-11 (lead 1) peak 80 and 10-13 (lead 3) peak 70.
    // Realized peaks: 10-11 -> 70, 10-13 -> 90.
    const rows = [
      ...dayRows({
        date: "2026-10-10",
        scores: flat(60),
        window: { start: 9, end: 14, score: 60 },
        outlook: [
          { date: "2026-10-11", peak: 80 },
          { date: "2026-10-13", peak: 70 },
        ],
      }),
      ...dayRows({ date: "2026-10-11", scores: flat(55, { 12: 70 }) }),
      ...dayRows({ date: "2026-10-13", scores: flat(55, { 12: 90 }) }),
      closer("2026-10-14"),
    ];
    const r = windowMetrics(rows, { min: 1 });
    expect(r.outlook).toEqual([
      { leadDays: 1, days: 1, mae: 10, bias: 10, collecting: null },
      { leadDays: 3, days: 1, mae: 20, bias: -20, collecting: null },
    ]);
    const gated = windowMetrics(rows); // default min 10
    expect(gated.outlook[0]).toMatchObject({ leadDays: 1, days: 1, mae: null, bias: null, collecting: "collecting — 1 of 10 days" });
  });

  it("outlook ignores target days that are not finished or have no scored hours", () => {
    const rows = [
      ...dayRows({
        date: "2026-10-10",
        scores: flat(60),
        outlook: [{ date: "2026-10-11", peak: 80 }],
        window: { start: 9, end: 14, score: 60 },
      }),
      ...dayRows({ date: "2026-10-11", scores: flat(55, { 12: 70 }), window: { start: 9, end: 14, score: 60 } }),
    ];
    // 10-11 is the beach's latest date, so it is not finished.
    expect(windowMetrics(rows, { min: 1 }).outlook).toEqual([]);
  });
});

// --- Safety fixtures --------------------------------------------------------

const safe = (
  swim: string,
  colors: string[],
  rip?: SafetyRow["rip"],
  slug = "boca-raton",
  i = 0,
): SafetyRow => ({
  slug,
  hour_utc: hourIso(i),
  safety: { swim },
  flags: { colors },
  rip: rip ?? null,
});

describe("dominantFlag", () => {
  it("picks the most serious posted color", () => {
    expect(dominantFlag(["yellow", "purple"])).toBe("yellow");
    expect(dominantFlag(["green", "red"])).toBe("red");
    expect(dominantFlag(["double-red", "red"])).toBe("double-red");
    expect(dominantFlag(["purple"])).toBe("purple");
    expect(dominantFlag(["unknown"])).toBe("unknown");
    expect(dominantFlag([])).toBe("unknown");
    expect(dominantFlag(null)).toBe("unknown");
  });
});

describe("safetyMetrics", () => {
  it("empty input is collecting", () => {
    const r = safetyMetrics([]);
    expect(r.hours).toBe(0);
    expect(r.collecting).toBe("collecting — 0 of 50 hours");
    expect(r.informative.agreementRate).toBeNull();
  });

  it("cross-tabs swim level by flag and ignores unknown flags", () => {
    const rows = [
      safe("stay-out", ["red"]),
      safe("stay-out", ["double-red"]),
      safe("caution", ["yellow"]),
      safe("safe", ["yellow"]),
      safe("safe", ["green"]),
      safe("safe", ["unknown"]), // no flag known: not counted
      { slug: "x", hour_utc: hourIso(0), safety: null, flags: { colors: ["green"] } } as SafetyRow, // no swim level
    ];
    const r = safetyMetrics(rows, 5);
    expect(r.hours).toBe(5);
    expect(r.crossTab.red["stay-out"]).toBe(1);
    expect(r.crossTab["double-red"]["stay-out"]).toBe(1);
    expect(r.crossTab.yellow).toMatchObject({ safe: 1, caution: 1, "stay-out": 0 });
    expect(r.crossTab.green.safe).toBe(1);
  });

  it("the informative subset leaves out red and double-red hours", () => {
    const rows: SafetyRow[] = [];
    for (let i = 0; i < 40; i++) rows.push(safe("stay-out", ["red"])); // circular, must not inflate agreement
    rows.push(safe("caution", ["yellow"])); // agree
    rows.push(safe("stay-out", ["yellow"])); // agree
    rows.push(safe("safe", ["yellow"])); // we said safe under a yellow flag
    rows.push(safe("safe", ["green"])); // agree
    rows.push(safe("safe", ["green"])); // agree
    rows.push(safe("caution", ["green"], { level: "moderate", source: "model" })); // we were more careful
    const r = safetyMetrics(rows, 6);
    expect(r.hours).toBe(46);
    expect(r.informative.hours).toBe(6);
    expect(r.informative.yellowHours).toBe(3);
    expect(r.informative.greenHours).toBe(3);
    expect(r.informative.agreeHours).toBe(4);
    expect(r.informative.agreementRate).toBeCloseTo(4 / 6);
    expect(r.informative.yellowWeSaidSafe).toBe(1);
    expect(r.informative.greenWeCautioned).toBe(1);
    expect(r.informative.greenReasons).toEqual([{ reason: "moderate rip risk", hours: 1 }]);
  });

  it("explains green-flag cautions from the archived rip block", () => {
    const rows = [
      safe("caution", ["green"], { level: "high", source: "model" }),
      safe("stay-out", ["green"], { level: "high", source: "alert", alert: 1 }),
      safe("caution", ["green"], { level: "low", source: "model" }),
      safe("caution", ["green"], null),
      safe("caution", ["green"], { level: "high", source: "none" }),
    ];
    const r = safetyMetrics(rows, 1);
    const reasons = Object.fromEntries(r.informative.greenReasons.map((x) => [x.reason, x.hours]));
    expect(reasons).toEqual({
      "high rip risk": 1,
      "rip current warning": 1,
      "other (waves, thunder or an advisory)": 2,
      "no rip detail archived": 1,
    });
  });

  it("holds the agreement rate back below the minimum", () => {
    const rows = [safe("safe", ["green"]), safe("caution", ["yellow"])];
    const r = safetyMetrics(rows);
    expect(r.ready).toBe(false);
    expect(r.informative.collecting).toBe("collecting — 2 of 50 hours");
    expect(r.informative.agreementRate).toBeNull();
    expect(r.informative.agreeHours).toBe(2); // counts stay visible
  });
});

// --- Data health ------------------------------------------------------------

const NOW = Date.parse("2026-10-10T12:00:00Z");
function hrow(slug: string, hoursAgo: number, has_extra: boolean, over: Partial<HourlyRow> = {}): HealthRow {
  const ms = NOW - hoursAgo * 3_600_000;
  return {
    slug,
    hour_utc: new Date(ms).toISOString(),
    local_date: new Date(ms - 4 * 3_600_000).toISOString().slice(0, 10),
    has_extra,
    ...over,
  };
}

describe("dataHealth", () => {
  it("counts rows per day over finished days and lists thin beaches", () => {
    const rows: HealthRow[] = [];
    // "full" beach: every hour for the last 7 days. "thin" beach: every 4th hour.
    for (let h = 0; h < 7 * 24; h++) {
      rows.push(hrow("full", h, false));
      if (h % 4 === 0) rows.push(hrow("thin", h, false));
    }
    const r = dataHealth({
      rows,
      camLatest: null,
      sunObs: null,
      sunPredictionsLast24h: null,
      nowMs: NOW,
      tierOf: (s) => (s === "full" ? "curated" : "auto"),
    });
    const full = r.perBeach.find((b) => b.slug === "full")!;
    const thin = r.perBeach.find((b) => b.slug === "thin")!;
    expect(full.perDay).toBe(24);
    expect(full.tier).toBe("curated");
    expect(thin.perDay).toBe(6);
    expect(thin.tier).toBe("auto");
    expect(r.beaches).toBe(2);
    expect(r.underMin.map((b) => b.slug)).toEqual(["thin"]);
    expect(r.perBeach[0].slug).toBe("thin"); // worst first
  });

  it("finds the local hours that go missing on full-day beaches", () => {
    // A curated beach archives every local hour except 16-19 (the daily build budget
    // ran out) for 5 days in a row; an auto beach has only a few daylight hours.
    const rows: HealthRow[] = [];
    for (let day = 1; day <= 5; day++) {
      const date = `2026-10-0${day + 3}`;
      for (let hour = 0; hour < 24; hour++) {
        const ms = Date.parse(`${date}T00:00:00Z`) + (hour + 4) * 3_600_000;
        const base = { local_date: date, local_hour: hour, has_extra: false, hour_utc: new Date(ms).toISOString() };
        if (hour < 16 || hour > 19) rows.push({ slug: "curated-beach", ...base });
        if (hour >= 8 && hour <= 14) rows.push({ slug: "auto-beach", ...base });
      }
    }
    const r = dataHealth({
      rows,
      camLatest: null,
      sunObs: null,
      sunPredictionsLast24h: null,
      nowMs: Date.parse("2026-10-10T12:00:00Z"),
      tierOf: (s) => (s === "curated-beach" ? "curated" : "auto"),
      expectedPerDay: (s) => (s === "curated-beach" ? 24 : 11),
    });
    expect(r.hourGaps?.beaches).toBe(1);
    expect(r.hourGaps?.missing.map((m) => m.hour)).toEqual([16, 17, 18, 19]);
    expect(r.hourGaps?.missing.every((m) => m.pct === 0)).toBe(true);
    const auto = r.perBeach.find((b) => b.slug === "auto-beach")!;
    expect(auto.expected).toBe(11);
    expect(r.perBeach.find((b) => b.slug === "curated-beach")?.expected).toBe(24);
    // Worst coverage first: the auto beach has 7 of 11, the curated one 20 of 24.
    expect(r.perBeach[0].slug).toBe("auto-beach");
  });

  it("reports no hour gaps when rows carry no local hour", () => {
    const r = dataHealth({
      rows: [hrow("a", 30, false), hrow("a", 50, false), hrow("a", 80, false)],
      camLatest: null,
      sunObs: null,
      sunPredictionsLast24h: null,
      nowMs: NOW,
    });
    expect(r.hourGaps).toBeNull();
  });

  it("reports extra_json coverage three ways and per block", () => {
    const rows: HealthRow[] = [];
    // 48 hours back: extra_json exists only on the newest 12 hours.
    for (let h = 0; h < 48; h++) {
      const has = h < 12;
      rows.push(
        hrow("a", h, has, has ? { window: { startIso: "", endIso: "", score: 1 }, rain: null, flags: { colors: ["green"] } } : {}),
      );
    }
    const r = dataHealth({ rows, camLatest: null, sunObs: null, sunPredictionsLast24h: null, nowMs: NOW });
    expect(r.extra.rows).toBe(12);
    expect(r.extra.windowPct).toBe(25);
    expect(r.extra.last24hPct).toBe(50);
    expect(r.extra.sinceFirstPct).toBe(100);
    expect(r.extra.firstHourUtc).toBe(new Date(NOW - 11 * 3_600_000).toISOString());
    expect(r.blockPct24h.window).toBe(100);
    expect(r.blockPct24h.flags).toBe(100);
    expect(r.blockPct24h.rain).toBe(0);
    expect(r.blockPct24h.outlook).toBe(0);
  });

  it("handles no rows at all", () => {
    const r = dataHealth({ rows: [], camLatest: null, sunObs: null, sunPredictionsLast24h: null, nowMs: NOW });
    expect(r.beaches).toBe(0);
    expect(r.extra.windowPct).toBeNull();
    expect(r.extra.firstHourUtc).toBeNull();
    expect(r.blockPct24h.window).toBeNull();
  });

  it("lists cams oldest first and flags the stale ones", () => {
    const r = dataHealth({
      rows: [],
      camLatest: [
        { slug: "fresh", captured_at_utc: new Date(NOW - 1 * 3_600_000).toISOString() },
        { slug: "stale", captured_at_utc: new Date(NOW - 30 * 3_600_000).toISOString() },
      ],
      sunObs: { count: 1, latestScoredAt: "2026-10-06T12:00:00Z", latestEventIso: "2026-10-06T10:46:00Z" },
      sunPredictionsLast24h: 216,
      nowMs: NOW,
    });
    expect(r.cams?.map((c) => c.slug)).toEqual(["stale", "fresh"]);
    expect(r.cams?.[0].ageHours).toBe(30);
    expect(r.camsStale.map((c) => c.slug)).toEqual(["stale"]);
    expect(r.sunObs?.count).toBe(1);
    expect(r.sunPredictionsLast24h).toBe(216);
  });
});
