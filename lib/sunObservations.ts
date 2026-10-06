// Strict validation for POST /api/sun-observations (app/api/sun-observations/
// route.ts) — the body scripts/sun_cam_check.py uploads for one scored
// sunrise or sunset. The route is a public URL (a bearer token guards it, but
// it still gets no benefit of the doubt): every field is checked for type and
// range, unknown fields are rejected, and the event is cross-checked against
// things the server already knows — the cam registry (config/sun-cams.json),
// the beach's own solar times (lib/sources/sun.ts), and the series the score
// was supposedly taken from. Pure: no I/O, no clock reads (the caller passes
// `nowMs`).

import camsConfig from "@/config/sun-cams.json";
import { getLocation } from "@/config/locations";
import { computeSunTimes } from "@/lib/sources/sun";
import type { SunEventObservationRow } from "@/lib/history/types";

export const SUN_OBSERVATION_MAX_BODY_BYTES = 32 * 1024;
export const SUN_OBSERVATION_MAX_SERIES = 64;

const ALLOWED_KEYS = new Set([
  "slug", "event_kind", "event_date_local", "event_iso", "cam_id", "view", "distance_mi",
  "observed_score", "warm_frac", "colorfulness", "peak_frame_iso", "series", "score_version", "credit",
]);
const SERIES_KEYS = new Set(["t", "score", "warm_frac", "colorfulness", "warm_sat"]);

/** The event instant must sit within this of the beach's own computed time. */
const EVENT_TOLERANCE_MS = 5 * 60_000;
/** Series and peak frames must fall within this of the event (the script samples -35..+25 min). */
const FRAME_WINDOW_MS = 60 * 60_000;
/** observed_score must equal the series' best score, give or take rounding. */
const SCORE_TOLERANCE = 0.15;
const MAX_FUTURE_MS = 60_000;
const MAX_AGE_MS = 730 * 24 * 3600_000;

const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

export interface SunCamBeach {
  slug: string;
  lat: number;
  lon: number;
  distance_mi: number;
}
export interface SunCam {
  id: string;
  name: string;
  youtube_id: string;
  facing_azimuth_deg: number;
  lat: number;
  lon: number;
  credit: string;
  beaches: SunCamBeach[];
  sky_regions: number[][];
}

export const SUN_CAMS: SunCam[] = (camsConfig as unknown as { cams: SunCam[] }).cams;

export type SunObservationParse =
  | { ok: true; row: SunEventObservationRow }
  | { ok: false; error: string };

const fail = (error: string): SunObservationParse => ({ ok: false, error });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function numIn(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** An ISO-8601 UTC instant (…Z), as epoch ms, or null. */
function isoMs(v: unknown): number | null {
  if (typeof v !== "string" || !ISO_Z_RE.test(v)) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** The calendar day of an instant in an IANA zone, YYYY-MM-DD. */
export function localDateOf(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/**
 * What the view should be for an event at a cam: 'solar' when the cam looks
 * within 60 degrees of where the sun is at that event (nominally due east for a
 * sunrise, due west for a sunset), else 'antisolar'. East-facing cams: sunrise
 * is solar, sunset antisolar.
 */
export function expectedView(kind: "sunrise" | "sunset", facingDeg: number): "solar" | "antisolar" {
  const sunAz = kind === "sunrise" ? 90 : 270;
  const diff = Math.abs((((facingDeg - sunAz + 180) % 360) + 360) % 360 - 180);
  return diff <= 60 ? "solar" : "antisolar";
}

/**
 * Validate an upload. On success returns the row to store, with times
 * normalised to `toISOString()` form and `series_json` rebuilt from the
 * validated series (never the caller's raw text).
 */
export function parseSunObservation(body: unknown, nowMs: number): SunObservationParse {
  if (!isRecord(body)) return fail("body must be a JSON object");
  for (const k of Object.keys(body)) {
    if (!ALLOWED_KEYS.has(k)) return fail(`unknown field "${k}"`);
  }

  const { slug, event_kind: kind, event_date_local: dateLocal, cam_id: camId, view, series, score_version: version, credit } = body;
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) return fail("slug is invalid");
  if (kind !== "sunrise" && kind !== "sunset") return fail("event_kind must be sunrise or sunset");
  if (typeof dateLocal !== "string" || !DATE_RE.test(dateLocal)) return fail("event_date_local must be YYYY-MM-DD");
  if (typeof camId !== "string") return fail("cam_id is required");
  if (view !== "solar" && view !== "antisolar") return fail("view must be solar or antisolar");
  if (typeof version !== "string" || !VERSION_RE.test(version)) return fail("score_version is invalid");

  // Cam and beach must be a pair the registry knows, and the credit must be the registry's.
  const cam = SUN_CAMS.find((c) => c.id === camId);
  if (!cam) return fail("unknown cam_id");
  const beach = cam.beaches.find((b) => b.slug === slug);
  if (!beach) return fail("this cam does not observe that beach");
  const loc = getLocation(slug);
  if (!loc) return fail("unknown beach");
  if (credit !== cam.credit) return fail("credit does not match the cam's registered credit");
  if (view !== expectedView(kind, cam.facing_azimuth_deg)) return fail("view does not match the event and the cam's facing");

  const distance = numIn(body.distance_mi, 0, 25);
  if (distance === null || Math.abs(distance - beach.distance_mi) > 0.05) return fail("distance_mi does not match the registry");

  // The event instant: well-formed, not in the future, not ancient, on the stated local day,
  // and where the beach's own solar calculation puts it.
  const eventMs = isoMs(body.event_iso);
  if (eventMs === null) return fail("event_iso must be an ISO-8601 UTC time");
  if (eventMs > nowMs + MAX_FUTURE_MS) return fail("event_iso is in the future");
  if (eventMs < nowMs - MAX_AGE_MS) return fail("event_iso is too old");
  if (localDateOf(eventMs, loc.timezone) !== dateLocal) return fail("event_date_local does not match event_iso in the beach's time zone");
  const [y, m, d] = dateLocal.split("-").map(Number);
  const sun = computeSunTimes(loc.lat, loc.lon, y, m, d);
  const expected = kind === "sunrise" ? sun.sunrise : sun.sunset;
  if (!expected || Math.abs(expected.getTime() - eventMs) > EVENT_TOLERANCE_MS) {
    return fail("event_iso is not the beach's computed sunrise/sunset");
  }

  const score = numIn(body.observed_score, 0, 100);
  const warmFrac = numIn(body.warm_frac, 0, 1);
  const colorfulness = numIn(body.colorfulness, 0, 255);
  if (score === null) return fail("observed_score must be 0-100");
  if (warmFrac === null) return fail("warm_frac must be 0-1");
  if (colorfulness === null) return fail("colorfulness must be 0-255");

  const peakMs = isoMs(body.peak_frame_iso);
  if (peakMs === null) return fail("peak_frame_iso must be an ISO-8601 UTC time");

  if (!Array.isArray(series) || series.length < 1 || series.length > SUN_OBSERVATION_MAX_SERIES) {
    return fail(`series must hold 1-${SUN_OBSERVATION_MAX_SERIES} frames`);
  }
  const frames: { t: string; score: number; warm_frac: number; colorfulness: number; warm_sat: number }[] = [];
  let prevMs = -Infinity;
  let bestScore = -Infinity;
  let peakInSeries = false;
  for (const raw of series) {
    if (!isRecord(raw)) return fail("series entries must be objects");
    for (const k of Object.keys(raw)) {
      if (!SERIES_KEYS.has(k)) return fail(`unknown series field "${k}"`);
    }
    const tMs = isoMs(raw.t);
    const fs = numIn(raw.score, 0, 100);
    const fw = numIn(raw.warm_frac, 0, 1);
    const fc = numIn(raw.colorfulness, 0, 255);
    const fp = numIn(raw.warm_sat, 0, 1);
    if (tMs === null || fs === null || fw === null || fc === null || fp === null) return fail("a series entry is malformed");
    if (Math.abs(tMs - eventMs) > FRAME_WINDOW_MS) return fail("a series frame is outside the event window");
    if (tMs <= prevMs) return fail("series frames must be in strictly increasing time order");
    prevMs = tMs;
    bestScore = Math.max(bestScore, fs);
    if (tMs === peakMs) peakInSeries = true;
    frames.push({ t: new Date(tMs).toISOString(), score: fs, warm_frac: fw, colorfulness: fc, warm_sat: fp });
  }
  if (!peakInSeries) return fail("peak_frame_iso is not one of the series frames");
  if (Math.abs(bestScore - score) > SCORE_TOLERANCE) return fail("observed_score is not the series' peak score");

  const row: SunEventObservationRow = {
    slug,
    event_kind: kind,
    event_date_local: dateLocal,
    cam_id: cam.id,
    event_iso: new Date(eventMs).toISOString(),
    view,
    distance_mi: beach.distance_mi,
    observed_score: score,
    warm_frac: warmFrac,
    colorfulness,
    peak_frame_iso: new Date(peakMs).toISOString(),
    series_json: JSON.stringify(frames),
    score_version: version,
    credit: cam.credit,
    created_at: new Date(nowMs).toISOString(),
  };
  return { ok: true, row };
}
