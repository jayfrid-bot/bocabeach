// Validation for POST /api/sun-observations (lib/sunObservations.ts): the
// happy path, then every way a body can be wrong — including the series-derived
// numbers (robust peak, temporal coverage) the server recomputes itself.

import { describe, it, expect } from "vitest";
import {
  AROUND_END_MIN,
  MIN_FRAMES_PER_BUCKET,
  PRE_END_MIN,
  SUN_OBSERVATION_MAX_SERIES,
  coverageCounts,
  expectedView,
  localDateOf,
  parseSunObservation,
  robustPeak,
} from "@/lib/sunObservations";
import { ELBO_SUNRISE_ISO, NOW_AFTER_OCT6_SUNRISE, eventIso, sunObservationBody, sunSeries } from "@/lib/sunObservations.fixtures";

const NOW = Date.parse(NOW_AFTER_OCT6_SUNRISE);
const EVENT_MS = Date.parse(ELBO_SUNRISE_ISO);

function bad(body: unknown, now = NOW): string {
  const r = parseSunObservation(body, now);
  if (r.ok) throw new Error("expected a rejection");
  return r.error;
}

type Frame = ReturnType<typeof sunSeries>[number];

/** A body for the Elbo sunrise whose series is `series`, with the top-level numbers
 *  an HONEST client would send for it (so a test breaks only what it means to). */
function honestBody(series: Frame[], over: Record<string, unknown> = {}): Record<string, unknown> {
  const base = sunObservationBody();
  const rp = robustPeak(series);
  const frame = rp ? series[rp.index] : series[0];
  return {
    ...base,
    series,
    observed_score: Math.round((rp?.value ?? 0) * 10) / 10,
    warm_frac: frame.warm_frac,
    colorfulness: frame.colorfulness,
    peak_frame_iso: frame.t,
    ...over,
  };
}

const at = (minutes: number) => new Date(EVENT_MS + minutes * 60_000).toISOString();
const frame = (minutes: number, score: number): Frame => ({ t: at(minutes), score, warm_frac: 0.1, colorfulness: 40, warm_sat: 0.4 });

describe("parseSunObservation — accepts what the script sends", () => {
  it("the Elbo Room 2026-10-06 sunrise", () => {
    const r = parseSunObservation(sunObservationBody(), NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row).toMatchObject({
      slug: "fort-lauderdale",
      event_kind: "sunrise",
      event_date_local: "2026-10-06",
      cam_id: "ftl-elbo-beach-cam",
      event_iso: ELBO_SUNRISE_ISO,
      view: "solar",
      distance_mi: 0,
      observed_score: 94.3,
      score_version: "2026-10-06.1",
      scored_at: NOW_AFTER_OCT6_SUNRISE,
      credit: "Live stream courtesy Elbo Room (ElboRoom.com)",
      created_at: NOW_AFTER_OCT6_SUNRISE,
    });
    expect(JSON.parse(r.row.series_json)).toHaveLength(25);
  });

  it("a sunset is antisolar for an east-facing cam", () => {
    const body = sunObservationBody({ kind: "sunset", peakAtMin: 10, scoredAt: "2026-10-07T00:00:00.000Z" });
    const r = parseSunObservation(body, Date.parse("2026-10-07T03:00:00Z"));
    expect(r.ok && r.row.view).toBe("antisolar");
    expect(expectedView("sunset", 90)).toBe("antisolar");
    expect(expectedView("sunrise", 90)).toBe("solar");
    expect(expectedView("sunset", 270)).toBe("solar");
  });

  it("a Deerfield cam reporting for Boca Raton carries the 2.9 mi distance", () => {
    const r = parseSunObservation(sunObservationBody({ slug: "boca-raton", camId: "deerfield-surf-cam" }), NOW);
    expect(r.ok && r.row.distance_mi).toBe(2.9);
  });

  it("rebuilds series_json from the validated series, not the caller's text", () => {
    const r = parseSunObservation(sunObservationBody(), NOW);
    expect(r.ok && Object.keys(JSON.parse(r.row.series_json)[0])).toEqual(["t", "score", "warm_frac", "colorfulness", "warm_sat"]);
  });

  it("works for a sunset whose UTC date is the next day (June, Boca Raton)", () => {
    const iso = eventIso("boca-raton", "sunset", "2027-06-21");
    expect(iso.startsWith("2027-06-22")).toBe(true);
    const body = sunObservationBody({
      slug: "boca-raton",
      camId: "deerfield-beach-cam",
      kind: "sunset",
      date: "2027-06-21",
      peakAtMin: 10,
      scoredAt: "2027-06-22T01:00:00.000Z",
    });
    expect(parseSunObservation(body, Date.parse("2027-06-22T03:00:00Z")).ok).toBe(true);
  });

  it("accepts a score_version whose counter has two digits", () => {
    expect(parseSunObservation(sunObservationBody({ version: "2026-10-06.12" }), NOW).ok).toBe(true);
  });
});

describe("parseSunObservation — rejects", () => {
  it("non-objects and unknown fields", () => {
    expect(bad(null)).toMatch(/object/);
    expect(bad([])).toMatch(/object/);
    expect(bad("x")).toMatch(/object/);
    expect(bad(sunObservationBody({}, { extra: 1 }))).toMatch(/unknown field "extra"/);
    const body = sunObservationBody();
    (body.series as Record<string, unknown>[])[0].junk = 1;
    expect(bad(body)).toMatch(/unknown series field/);
  });

  it("bad identifiers and enums", () => {
    expect(bad(sunObservationBody({}, { slug: "Boca Raton!" }))).toMatch(/slug/);
    expect(bad(sunObservationBody({}, { event_kind: "noon" }))).toMatch(/event_kind/);
    expect(bad(sunObservationBody({}, { event_date_local: "10/06/2026" }))).toMatch(/event_date_local/);
    expect(bad(sunObservationBody({}, { view: "sideways" }))).toMatch(/view/);
    expect(bad(sunObservationBody({}, { cam_id: 7 }))).toMatch(/cam_id/);
  });

  it("a score_version that is not YYYY-MM-DD.N", () => {
    for (const v of ["has spaces", "v2", "2026-10-06", "2026-10-06.", "2026-10-06.x", "2026-10-06.1234", 7]) {
      expect(bad(sunObservationBody({}, { score_version: v }))).toMatch(/score_version/);
    }
  });

  it("a scored_at that is missing, malformed, in the future, before the event, or before the last frame", () => {
    expect(bad(sunObservationBody({}, { scored_at: undefined }))).toMatch(/scored_at/);
    expect(bad(sunObservationBody({}, { scored_at: "yesterday" }))).toMatch(/scored_at/);
    expect(bad(sunObservationBody({}, { scored_at: "2026-10-06T14:10:00.000Z" }))).toMatch(/scored_at is in the future/);
    expect(bad(sunObservationBody({}, { scored_at: "2026-10-06T11:00:00.000Z" }))).toMatch(/before the event/);
    expect(bad(sunObservationBody({}, { scored_at: "2026-10-06T11:30:00.000Z" }))).toMatch(/before the last series frame/);
  });

  it("an unknown cam, an unpaired beach, a wrong credit, the wrong view, the wrong distance", () => {
    expect(bad(sunObservationBody({}, { cam_id: "mystery-cam" }))).toMatch(/unknown cam_id/);
    expect(bad(sunObservationBody({}, { slug: "boca-raton" }))).toMatch(/does not observe/);
    expect(bad(sunObservationBody({}, { credit: "Live stream courtesy Someone Else" }))).toMatch(/credit/);
    expect(bad(sunObservationBody({}, { credit: undefined }))).toMatch(/credit/);
    expect(bad(sunObservationBody({}, { view: "antisolar" }))).toMatch(/view does not match/);
    expect(bad(sunObservationBody({ slug: "boca-raton", camId: "deerfield-beach-cam" }, { distance_mi: 0.2 }))).toMatch(/distance_mi/);
  });

  it("an event in the future, ancient, on the wrong local day, or not at the beach's sun time", () => {
    expect(bad(sunObservationBody(), Date.parse("2026-10-06T10:00:00Z"))).toMatch(/future/);
    expect(bad(sunObservationBody(), Date.parse("2029-10-06T10:00:00Z"))).toMatch(/too old/);
    expect(bad(sunObservationBody({}, { event_date_local: "2026-10-07" }))).toMatch(/event_date_local does not match/);
    const iso = new Date(EVENT_MS + 20 * 60_000).toISOString();
    expect(bad(sunObservationBody({}, { event_iso: iso, peak_frame_iso: iso }))).toMatch(/computed/);
    expect(bad(sunObservationBody({}, { event_iso: "2026-10-06 11:15:11" }))).toMatch(/event_iso/);
    expect(bad(sunObservationBody({}, { event_iso: "2026-10-06T11:15:11.868+00:00" }))).toMatch(/event_iso/);
  });

  it("scores and fractions out of range, NaN, or the wrong type", () => {
    expect(bad(sunObservationBody({}, { observed_score: 101 }))).toMatch(/observed_score/);
    expect(bad(sunObservationBody({}, { observed_score: -1 }))).toMatch(/observed_score/);
    expect(bad(sunObservationBody({}, { observed_score: "94" }))).toMatch(/observed_score/);
    expect(bad(sunObservationBody({}, { warm_frac: 1.2 }))).toMatch(/warm_frac/);
    expect(bad(sunObservationBody({}, { colorfulness: 300 }))).toMatch(/colorfulness/);
    expect(bad(sunObservationBody({}, { distance_mi: NaN }))).toMatch(/distance_mi/);
  });

  it("a series that is empty, too long, malformed, out of window, or out of order", () => {
    const base = sunSeries(EVENT_MS, 94.3);
    expect(bad(sunObservationBody({}, { series: [] }))).toMatch(/series must hold/);
    expect(bad(sunObservationBody({}, { series: "no" }))).toMatch(/series must hold/);
    const long = Array.from({ length: SUN_OBSERVATION_MAX_SERIES + 1 }, (_, i) => ({ ...base[5], t: new Date(EVENT_MS - 40 * 60_000 + i * 1000).toISOString() }));
    expect(bad(sunObservationBody({}, { series: long }))).toMatch(/series must hold/);
    expect(bad(sunObservationBody({}, { series: [...base.slice(0, 10), { ...base[10], score: 101 }] }))).toMatch(/malformed/);
    expect(bad(sunObservationBody({}, { series: [...base, "x"] }))).toMatch(/objects/);
    const far = { ...base[1], t: new Date(EVENT_MS + 3 * 3600_000).toISOString() };
    expect(bad(honestBody([...base, far]))).toMatch(/outside the event window/);
    expect(bad(honestBody([base[1], base[0], ...base.slice(2)]))).toMatch(/increasing/);
  });
});

describe("parseSunObservation — the series decides the peak, not the client", () => {
  it("rejects a peak_frame_iso that is not the series' robust peak frame", () => {
    const body = sunObservationBody();
    const series = body.series as Frame[];
    const other = series.find((f) => f.t !== body.peak_frame_iso)!;
    expect(bad({ ...body, peak_frame_iso: other.t })).toMatch(/robust peak frame/);
    expect(bad({ ...body, peak_frame_iso: at(-5.5) })).toMatch(/robust peak frame/); // not even a frame
  });

  it("rejects an observed_score that is not the recomputed robust peak (higher or lower)", () => {
    expect(bad(sunObservationBody({}, { observed_score: 99 }))).toMatch(/robust peak/);
    expect(bad(sunObservationBody({}, { observed_score: 94.3 - 1 }))).toMatch(/robust peak/);
    expect(parseSunObservation(sunObservationBody({}, { observed_score: 94.3 + 0.04 }), NOW).ok).toBe(true); // rounding slack
  });

  it("rejects top-level warm_frac / colorfulness that do not match the peak frame's own", () => {
    const body = sunObservationBody();
    expect(bad({ ...body, warm_frac: 0.5 })).toMatch(/warm_frac does not match/);
    expect(bad({ ...body, colorfulness: 80 })).toMatch(/colorfulness does not match/);
  });

  it("an isolated spike is cut to twice its best neighbor: the client cannot claim the spike", () => {
    const series = sunSeries(EVENT_MS, 40).map((f) => ({ ...f, score: 12 }));
    series[10] = { ...series[10], score: 95 }; // a glitch frame among 12s
    const honest = honestBody(series);
    expect(honest.observed_score).toBe(24); // min(95, 2 * 12)
    expect(parseSunObservation(honest, NOW).ok).toBe(true);
    // claiming the spike's own value is refused
    expect(bad({ ...honest, observed_score: 95 })).toMatch(/robust peak/);
  });

  it("rejects a series with no frame that has a close neighbor", () => {
    // frames 10 min apart: none confirms another
    const sparse = [-30, -20, -10, 0, 10, 20].map((m) => frame(m, 50));
    expect(bad(honestBody(sparse))).toMatch(/does not cover|no frame with a neighbor/);
  });
});

describe("parseSunObservation — temporal coverage is recomputed from the series", () => {
  it("rejects a capture that stops at the event (no post-event frames)", () => {
    const series = sunSeries(EVENT_MS, 94.3).filter((f) => Date.parse(f.t) <= EVENT_MS + 5 * 60_000);
    expect(bad(honestBody(series))).toMatch(/0 post|1 post|2 post/);
    expect(bad(honestBody(series))).toMatch(/series does not cover the event/);
  });

  it("rejects a capture that starts at the event (no pre-event frames)", () => {
    const series = sunSeries(EVENT_MS, 94.3, 5).filter((f) => Date.parse(f.t) >= EVENT_MS - 10 * 60_000);
    expect(bad(honestBody(series))).toMatch(/series does not cover the event/);
  });

  it("rejects a bucket one frame short, accepts it at exactly the minimum", () => {
    const full = sunSeries(EVENT_MS, 94.3);
    const keep = (limit: number) => {
      let pre = 0;
      return full.filter((f) => {
        const m = (Date.parse(f.t) - EVENT_MS) / 60_000;
        if (m < PRE_END_MIN) return ++pre <= limit;
        return true;
      });
    };
    expect(bad(honestBody(keep(MIN_FRAMES_PER_BUCKET - 1)))).toMatch(/series does not cover the event/);
    expect(parseSunObservation(honestBody(keep(MIN_FRAMES_PER_BUCKET)), NOW).ok).toBe(true);
  });

  it("coverageCounts buckets by minutes from the event", () => {
    const ms = (m: number) => EVENT_MS + m * 60_000;
    expect(coverageCounts([-35, -12.1, -12, 0, AROUND_END_MIN, AROUND_END_MIN + 0.1, 25].map(ms), EVENT_MS)).toEqual({ pre: 2, around: 3, post: 2 });
    expect(coverageCounts([-36, 26].map(ms), EVENT_MS)).toEqual({ pre: 0, around: 0, post: 0 }); // outside the window
  });
});

describe("robustPeak", () => {
  it("a real, sharp peak beside a lower frame is untouched", () => {
    const r = robustPeak([frame(-7.5, 28.3), frame(-5, 94.4), frame(-2.5, 59.3)]);
    expect(r).toEqual({ index: 1, value: 94.4 });
  });

  it("an isolated spike is cut to 2x its best neighbor", () => {
    expect(robustPeak([frame(-5, 10), frame(-2.5, 95), frame(0, 12)])?.value).toBe(24);
  });

  it("frames five minutes apart still corroborate each other (the saved 5-minute backfill frames)", () => {
    expect(robustPeak([frame(-15, 28.3), frame(-10, 94.4), frame(-5, 59.3)])?.value).toBe(94.4);
  });

  it("a frame with no neighbor within 5 minutes does not count; none counting is null", () => {
    expect(robustPeak([frame(-20, 99), frame(-10, 40), frame(-7.5, 38)])).toEqual({ index: 1, value: 40 });
    expect(robustPeak([frame(-20, 99), frame(0, 40)])).toBeNull();
    expect(robustPeak([])).toBeNull();
  });

  it("ties go to the earliest frame", () => {
    expect(robustPeak([frame(-5, 50), frame(-2.5, 50)])?.index).toBe(0);
  });
});

describe("localDateOf", () => {
  it("reads the calendar day in the beach's zone, not UTC", () => {
    expect(localDateOf(Date.parse("2027-06-22T00:15:00Z"), "America/New_York")).toBe("2027-06-21");
    expect(localDateOf(Date.parse("2026-10-06T11:15:00Z"), "America/New_York")).toBe("2026-10-06");
  });
});

describe("the real uploader payload (cross-language contract)", () => {
  it("accepts what scripts/sun_cam_check.py --from-dir produced for the 2026-10-06 Elbo Room sunrise", async () => {
    // lib/__fixtures__/sunCamOct6ElboPayload.json is the script's own --json output on the saved frames.
    const payload = (await import("@/lib/__fixtures__/sunCamOct6ElboPayload.json")).default as Record<string, unknown>;
    const r = parseSunObservation(payload, Date.parse("2026-10-07T00:00:00Z"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.observed_score).toBeGreaterThanOrEqual(90);
    expect(r.row.observed_score).toBeLessThanOrEqual(97);
    expect(r.row.event_iso).toBe(ELBO_SUNRISE_ISO);
    expect(r.row.peak_frame_iso).toBe("2026-10-06T11:05:00.000Z");
    expect(r.row.score_version).toMatch(/^2026-10-0[67]\.\d+$/);
    expect(JSON.parse(r.row.series_json)).toHaveLength(12);
  });

  it("accepts a python-built capture whose glitch frame was cut by the robust peak (python and TypeScript agree)", async () => {
    // One 95 among ~12s: the script's robust_peak cuts it to twice its best neighbor; robustPeak must land on the same number and frame.
    const payload = (await import("@/lib/__fixtures__/sunCamCappedSpikePayload.json")).default as Record<string, unknown>;
    const r = parseSunObservation(payload, Date.parse("2026-10-06T15:00:00Z"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const series = JSON.parse(r.row.series_json) as { t: string; score: number }[];
    expect(Math.max(...series.map((f) => f.score))).toBe(95); // the raw spike is in the series...
    expect(r.row.observed_score).toBeLessThan(35); // ...but is not the event score
    expect(r.row.observed_score).toBe(robustPeak(series)?.value);
  });
});
