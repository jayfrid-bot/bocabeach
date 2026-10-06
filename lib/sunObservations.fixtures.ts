// Shared fixtures for the sun-observation tests (not a test file itself).

import { getLocation } from "@/config/locations";
import { computeSunTimes } from "@/lib/sources/sun";
import { SUN_CAMS, expectedView, robustPeak } from "@/lib/sunObservations";
import type { SunEventObservationRow, SunEventPredictionRow } from "@/lib/history/types";

/** The sunrise the Elbo Room frames of 2026-10-06 recorded (the first labelled example). */
export const ELBO_SUNRISE_ISO = "2026-10-06T11:15:11.868Z";
/** A "now" a few hours after that sunrise — what the route tests freeze the clock at. */
export const NOW_AFTER_OCT6_SUNRISE = "2026-10-06T14:00:00.000Z";

/** The beach's own computed sunrise/sunset instant for a local date, as the app makes it. */
export function eventIso(slug: string, kind: "sunrise" | "sunset", date: string): string {
  const loc = getLocation(slug);
  if (!loc) throw new Error(`no beach ${slug}`);
  const [y, m, d] = date.split("-").map(Number);
  const t = computeSunTimes(loc.lat, loc.lon, y, m, d);
  const at = kind === "sunrise" ? t.sunrise : t.sunset;
  if (!at) throw new Error("no sun event");
  return at.toISOString();
}

export interface BodyOpts {
  slug?: string;
  camId?: string;
  kind?: "sunrise" | "sunset";
  date?: string;
  /** the peak frame's score (the series' best) */
  peak?: number;
  /** minutes from the event of the peak frame (default -5: peak color is usually just BEFORE a sunrise) */
  peakAtMin?: number;
  version?: string;
  scoredAt?: string;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;

/** The 25-frame series the script samples (event-35 min .. event+25 min every 2.5 min),
 *  shaped like a real peak: it climbs to `peak` at `peakAtMin` and falls away, so every
 *  frame beside the peak is within a factor of 2 of it. */
export function sunSeries(eventMs: number, peak: number, peakAtMin = -5) {
  return Array.from({ length: 25 }, (_, k) => {
    const offset = -35 + 2.5 * k;
    const shape = Math.max(0.15, 1 - Math.abs(offset - peakAtMin) / 20);
    return {
      t: new Date(eventMs + offset * 60_000).toISOString(),
      score: round(peak * shape, 1),
      warm_frac: round(0.3177 * shape, 4),
      colorfulness: round(30 + 37.7 * shape, 1),
      warm_sat: round(0.2 + 0.3 * shape, 3),
    };
  });
}

/** A valid upload body (exactly what scripts/sun_cam_check.py sends). `over`
 *  replaces any field afterwards, so a test can break one thing. */
export function sunObservationBody(opts: BodyOpts = {}, over: Record<string, unknown> = {}): Record<string, unknown> {
  const slug = opts.slug ?? "fort-lauderdale";
  const camId = opts.camId ?? "ftl-elbo-beach-cam";
  const kind = opts.kind ?? "sunrise";
  const date = opts.date ?? "2026-10-06";
  const peak = opts.peak ?? 94.3;
  const cam = SUN_CAMS.find((c) => c.id === camId);
  const beach = cam?.beaches.find((b) => b.slug === slug);
  if (!cam || !beach) throw new Error(`cam ${camId} does not observe ${slug}`);
  const iso = eventIso(slug, kind, date);
  const series = sunSeries(Date.parse(iso), peak, opts.peakAtMin);
  const rp = robustPeak(series);
  if (!rp) throw new Error("fixture series has no peak");
  const peakFrame = series[rp.index];
  return {
    slug,
    event_kind: kind,
    event_date_local: date,
    event_iso: iso,
    cam_id: camId,
    view: expectedView(kind, cam.facing_azimuth_deg),
    distance_mi: beach.distance_mi,
    observed_score: round(rp.value, 1),
    warm_frac: peakFrame.warm_frac,
    colorfulness: peakFrame.colorfulness,
    peak_frame_iso: peakFrame.t,
    series,
    score_version: opts.version ?? "2026-10-06.1",
    scored_at: opts.scoredAt ?? NOW_AFTER_OCT6_SUNRISE,
    credit: cam.credit,
    ...over,
  };
}

/** A stored observation row, for store-level tests. */
export function observationRow(over: Partial<SunEventObservationRow> = {}): SunEventObservationRow {
  return {
    slug: "boca-raton",
    event_kind: "sunrise",
    event_date_local: "2026-10-06",
    cam_id: "deerfield-beach-cam",
    event_iso: "2026-10-06T11:15:09.672Z",
    view: "solar",
    distance_mi: 2.9,
    observed_score: 90,
    warm_frac: 0.4,
    colorfulness: 80,
    peak_frame_iso: "2026-10-06T11:10:09.925Z",
    series_json: "[]",
    score_version: "2026-10-06.1",
    scored_at: "2026-10-06T14:05:00.000Z",
    credit: "Live stream courtesy City of Deerfield Beach",
    created_at: "2026-10-06T14:05:00.000Z",
    ...over,
  };
}

/** A `sun_event_predictions` row for the same event, no truth data yet. */
export function predictionRow(over: Partial<SunEventPredictionRow> = {}): SunEventPredictionRow {
  return {
    slug: "boca-raton",
    event_kind: "sunrise",
    event_iso: "2026-10-06T11:15:09.672Z",
    as_of_hour_utc: "2026-10-06T10:00:00.000Z",
    snapshot_generated_at: "2026-10-06T10:05:00.000Z",
    archived_at: "2026-10-06T10:05:01.000Z",
    lead_minutes: 70,
    score: 58,
    band: "good",
    model_path: "factor",
    note: "test note",
    breakdown_json: null,
    low_cloud_pct: 0,
    mid_cloud_pct: 67,
    high_cloud_pct: 48,
    total_cloud_pct: 67,
    humidity_pct: 87,
    aod: 0.14,
    pm2_5: 13.6,
    horizon_cloud_pct: 40,
    horizon_source: "overhead",
    horizon_fresh: 1,
    seasonal_prior: 55,
    point_time: "2026-10-06T11:00:00.000Z",
    peak_color_iso: "2026-10-06T11:15:00.000Z",
    peak_offset_minutes: 0,
    algo_version: "2026-10-06.1",
    engine_version: "test-1",
    build_sha: "abc123",
    observed_score: null,
    observed_source: null,
    observed_at: null,
    ...over,
  };
}
