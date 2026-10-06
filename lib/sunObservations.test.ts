// Validation for POST /api/sun-observations (lib/sunObservations.ts): the
// happy path, then every way a body can be wrong.

import { describe, it, expect } from "vitest";
import { parseSunObservation, expectedView, localDateOf, SUN_OBSERVATION_MAX_SERIES } from "@/lib/sunObservations";
import { ELBO_SUNRISE_ISO, NOW_AFTER_OCT6_SUNRISE, eventIso, sunObservationBody } from "@/lib/sunObservations.fixtures";

const NOW = Date.parse(NOW_AFTER_OCT6_SUNRISE);

function bad(body: unknown, now = NOW): string {
  const r = parseSunObservation(body, now);
  if (r.ok) throw new Error("expected a rejection");
  return r.error;
}

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
      credit: "Live stream courtesy Elbo Room (ElboRoom.com)",
      created_at: NOW_AFTER_OCT6_SUNRISE,
    });
    expect(JSON.parse(r.row.series_json)).toHaveLength(4);
  });

  it("a sunset is antisolar for an east-facing cam", () => {
    const r = parseSunObservation(sunObservationBody({ kind: "sunset" }), Date.parse("2026-10-07T03:00:00Z"));
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
    const body = sunObservationBody({ slug: "boca-raton", camId: "deerfield-beach-cam", kind: "sunset", date: "2027-06-21" });
    expect(parseSunObservation(body, Date.parse("2027-06-22T03:00:00Z")).ok).toBe(true);
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
    expect(bad(sunObservationBody({}, { score_version: "has spaces" }))).toMatch(/score_version/);
    expect(bad(sunObservationBody({}, { cam_id: 7 }))).toMatch(/cam_id/);
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
    const iso = new Date(Date.parse(ELBO_SUNRISE_ISO) + 20 * 60_000).toISOString();
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

  it("a series that is empty, too long, malformed, out of window, out of order, or does not hold the peak", () => {
    expect(bad(sunObservationBody({}, { series: [] }))).toMatch(/series must hold/);
    expect(bad(sunObservationBody({}, { series: "no" }))).toMatch(/series must hold/);
    const base = sunObservationBody().series as Record<string, unknown>[];
    const long = Array.from({ length: SUN_OBSERVATION_MAX_SERIES + 1 }, (_, i) => ({ ...base[1], t: new Date(Date.parse(ELBO_SUNRISE_ISO) - 40 * 60_000 + i * 1000).toISOString() }));
    expect(bad(sunObservationBody({}, { series: long }))).toMatch(/series must hold/);
    expect(bad(sunObservationBody({}, { series: [base[0], { ...base[1], score: 101 }] }))).toMatch(/malformed/);
    expect(bad(sunObservationBody({}, { series: [...base, "x"] }))).toMatch(/objects/);
    const far = { ...base[1], t: new Date(Date.parse(ELBO_SUNRISE_ISO) + 3 * 3600_000).toISOString() };
    expect(bad(sunObservationBody({}, { series: [...base, far] }))).toMatch(/outside the event window/);
    expect(bad(sunObservationBody({}, { series: [base[1], base[0]] }))).toMatch(/increasing/);
    expect(bad(sunObservationBody({}, { peak_frame_iso: "2026-10-06T11:12:00.000Z" }))).toMatch(/not one of the series/);
    expect(bad(sunObservationBody({}, { observed_score: 60 }))).toMatch(/peak score/);
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
    const r = parseSunObservation(payload, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.row.observed_score).toBeGreaterThanOrEqual(90);
    expect(r.row.observed_score).toBeLessThanOrEqual(97);
    expect(r.row.event_iso).toBe(ELBO_SUNRISE_ISO);
    expect(r.row.peak_frame_iso).toBe("2026-10-06T11:05:00.000Z");
    expect(JSON.parse(r.row.series_json)).toHaveLength(12);
  });
});
