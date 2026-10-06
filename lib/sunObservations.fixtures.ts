// Shared fixtures for the sun-observation tests (not a test file itself).

import { getLocation } from "@/config/locations";
import { computeSunTimes } from "@/lib/sources/sun";
import { SUN_CAMS, expectedView } from "@/lib/sunObservations";
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
  const eventMs = Date.parse(iso);
  const at = (minutes: number) => new Date(eventMs + minutes * 60_000).toISOString();
  const series = [
    { t: at(-10), score: Math.min(30, peak), warm_frac: 0.08, colorfulness: 37.8, warm_sat: 0.41 },
    { t: at(-5), score: peak, warm_frac: 0.3177, colorfulness: 67.7, warm_sat: 0.5 },
    { t: at(0), score: Math.min(55, peak), warm_frac: 0.17, colorfulness: 52.1, warm_sat: 0.39 },
    { t: at(5), score: Math.min(22, peak), warm_frac: 0.05, colorfulness: 38, warm_sat: 0.37 },
  ];
  return {
    slug,
    event_kind: kind,
    event_date_local: date,
    event_iso: iso,
    cam_id: camId,
    view: expectedView(kind, cam.facing_azimuth_deg),
    distance_mi: beach.distance_mi,
    observed_score: peak,
    warm_frac: 0.3177,
    colorfulness: 67.7,
    peak_frame_iso: at(-5),
    series,
    score_version: "2026-10-06.1",
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
