// Strict validation for POST /api/sun-observations (app/api/sun-observations/
// route.ts) — the body scripts/sun_cam_check.py uploads for one scored
// sunrise or sunset. The route is a public URL (a bearer token guards it, but
// it still gets no benefit of the doubt): every field is checked for type and
// range, unknown fields are rejected, and the event is cross-checked against
// things the server already knows — the cam registry (config/sun-cams.json),
// the beach's own solar times (lib/sources/sun.ts), and the series the score
// was supposedly taken from: the server RECOMPUTES the robust peak and the
// temporal coverage from the series and never trusts the client's numbers.
// Pure: no I/O, no clock reads (the caller passes `nowMs`).

import camsConfig from "@/config/sun-cams.json";
import { getLocation } from "@/config/locations";
import { computeSunTimes } from "@/lib/sources/sun";
import type { SunEventObservationRow } from "@/lib/history/types";

export const SUN_OBSERVATION_MAX_BODY_BYTES = 32 * 1024;
export const SUN_OBSERVATION_MAX_SERIES = 64;

const ALLOWED_KEYS = new Set([
  "slug", "event_kind", "event_date_local", "event_iso", "cam_id", "view", "distance_mi",
  "observed_score", "warm_frac", "colorfulness", "peak_frame_iso", "series", "score_version", "scored_at", "credit",
]);
const SERIES_KEYS = new Set(["t", "score", "warm_frac", "colorfulness", "warm_sat"]);

/** The event instant must sit within this of the beach's own computed time. */
const EVENT_TOLERANCE_MS = 5 * 60_000;
/** Series and peak frames must fall within this of the event (the script samples -35..+25 min). */
const FRAME_WINDOW_MS = 60 * 60_000;
/** Rounding slack when the client's numbers are checked against the series (scores carry 1 decimal, warm_frac 4). */
const SCORE_TOLERANCE = 0.06;
const FRACTION_TOLERANCE = 0.0001;

// --- The robust peak (scripts/sun_cam_check.py robust_peak mirrors this exactly) ---
// A single frame can spike on a glitch or a lens flare, and real color builds and
// fades over minutes. So a frame counts for at most PEAK_NEIGHBOR_FACTOR times the
// best score among the OTHER frames within PEAK_NEIGHBOR_SECONDS of it, and a frame
// with no neighbor that close does not count at all. The event score is the best
// such value. A sharp but real peak (94 beside a 59) is untouched; an isolated
// spike (95 beside 10 and 12) is cut to 24.
export const PEAK_NEIGHBOR_SECONDS = 301;
export const PEAK_NEIGHBOR_FACTOR = 2;

// --- Temporal coverage: minutes relative to the event ---
// The series must hold at least MIN_FRAMES_PER_BUCKET usable frames in each of three buckets, so
// a capture that missed the build-up, the event, or the afterglow is never kept as ground truth.
// The peak color usually lands 5-15 min before a sunrise / after a sunset, which falls
// in the "around" bucket's edge or the buckets beside it; every bucket must still be sampled.
export const WINDOW_START_MIN = -35;
export const WINDOW_END_MIN = 25;
export const PRE_END_MIN = -12; // pre: [-35, -12)
export const AROUND_END_MIN = 8; // around: [-12, +8]; post: (+8, +25]
export const MIN_FRAMES_PER_BUCKET = 3;
const MAX_FUTURE_MS = 60_000;
const MAX_AGE_MS = 730 * 24 * 3600_000;

const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
/** YYYY-MM-DD.N — compared by date, then N as a number (see isNewerSunScore). */
const VERSION_RE = /^\d{4}-\d{2}-\d{2}\.\d{1,3}$/;

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

export interface SeriesFrame {
  t: string;
  score: number;
  warm_frac: number;
  colorfulness: number;
  warm_sat: number;
}

/**
 * The robust peak of a time-ordered series: the best over frames of
 * min(score, PEAK_NEIGHBOR_FACTOR * best score of the other frames within
 * PEAK_NEIGHBOR_SECONDS). Ties go to the earliest frame. Null when no frame has
 * a neighbor that close.
 */
export function robustPeak(frames: readonly { t: string; score: number }[]): { index: number; value: number } | null {
  const ms = frames.map((f) => Date.parse(f.t));
  let best: { index: number; value: number } | null = null;
  for (let i = 0; i < frames.length; i++) {
    let neighbor = -Infinity;
    for (let j = 0; j < frames.length; j++) {
      if (j !== i && Math.abs(ms[j] - ms[i]) <= PEAK_NEIGHBOR_SECONDS * 1000) neighbor = Math.max(neighbor, frames[j].score);
    }
    if (neighbor === -Infinity) continue;
    const value = Math.min(frames[i].score, PEAK_NEIGHBOR_FACTOR * neighbor);
    if (best === null || value > best.value) best = { index: i, value };
  }
  return best;
}

/** How many frames fall in each coverage bucket, by minutes from the event. */
export function coverageCounts(frameMs: readonly number[], eventMs: number): { pre: number; around: number; post: number } {
  const out = { pre: 0, around: 0, post: 0 };
  for (const t of frameMs) {
    const m = (t - eventMs) / 60_000;
    if (m < WINDOW_START_MIN || m > WINDOW_END_MIN) continue;
    if (m < PRE_END_MIN) out.pre += 1;
    else if (m <= AROUND_END_MIN) out.around += 1;
    else out.post += 1;
  }
  return out;
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
  const scoredMs = isoMs(body.scored_at);
  if (scoredMs === null) return fail("scored_at must be an ISO-8601 UTC time");
  if (scoredMs > nowMs + MAX_FUTURE_MS) return fail("scored_at is in the future");
  if (scoredMs < eventMs) return fail("scored_at is before the event");

  if (!Array.isArray(series) || series.length < 1 || series.length > SUN_OBSERVATION_MAX_SERIES) {
    return fail(`series must hold 1-${SUN_OBSERVATION_MAX_SERIES} frames`);
  }
  const frames: SeriesFrame[] = [];
  let prevMs = -Infinity;
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
    frames.push({ t: new Date(tMs).toISOString(), score: fs, warm_frac: fw, colorfulness: fc, warm_sat: fp });
  }
  if (scoredMs < prevMs) return fail("scored_at is before the last series frame");

  // Temporal coverage: recomputed here, never trusted from the client.
  const cov = coverageCounts(frames.map((f) => Date.parse(f.t)), eventMs);
  if (cov.pre < MIN_FRAMES_PER_BUCKET || cov.around < MIN_FRAMES_PER_BUCKET || cov.post < MIN_FRAMES_PER_BUCKET) {
    return fail(
      `series does not cover the event: ${cov.pre} pre, ${cov.around} around, ${cov.post} post frames (need ${MIN_FRAMES_PER_BUCKET} in each)`,
    );
  }

  // The robust peak, recomputed from the series. The declared peak must BE that frame, and the
  // top-level numbers must be what the series says, never what the client claims.
  const peak = robustPeak(frames);
  if (peak === null) return fail("series has no frame with a neighbor close enough to confirm a peak");
  const peakFrame = frames[peak.index];
  if (Date.parse(peakFrame.t) !== peakMs) return fail("peak_frame_iso is not the series' robust peak frame");
  if (Math.abs(peak.value - score) > SCORE_TOLERANCE) return fail("observed_score is not the series' robust peak");
  if (Math.abs(peakFrame.warm_frac - warmFrac) > FRACTION_TOLERANCE) return fail("warm_frac does not match the peak frame");
  if (Math.abs(peakFrame.colorfulness - colorfulness) > SCORE_TOLERANCE) return fail("colorfulness does not match the peak frame");

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
    scored_at: new Date(scoredMs).toISOString(),
    credit: cam.credit,
    created_at: new Date(nowMs).toISOString(),
  };
  return { ok: true, row };
}
