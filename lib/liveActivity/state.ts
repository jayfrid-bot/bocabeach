// Pure mapping from a ConditionsResponse (+ optional point hazard reads) to
// the Beach Session Live Activity's ContentState wire shape — see
// docs/LIVE_ACTIVITY_PLAN.md Phase 2 and ios/App/Shared/BeachSessionAttributes.swift.
//
// Field names here are EXACT matches for the Swift ContentState's Codable
// keys (v, seq, score, windMph, gustMph, windDeg, waveFt, clarity, seaweed,
// nextTideAt, nextTideKind, sunsetAt, lightning, updatedAt, unavailable,
// ended) minus `v`/`seq`/`ended`, which the caller (lib/plus/liveActivity.ts
// / BeachModeCard) attaches — those are about UPDATE SEQUENCING, not derived
// from conditions. Dates are epoch ms (not ISO): the Swift side decodes Date
// from a JS-bridge-friendly number.
//
// No re-derivation of hazard logic: the lightning active/latched decision
// always comes from lib/hazards/assess.ts's assessLightning, either the
// POINT assessment the card already has from /api/hazards, or — when there
// isn't one — a beach-anchored assessment built here from the SAME function
// fed the beach's own snapshot.lightning reading. This mirrors score.ts's own
// call exactly, so the Lock Screen can never disagree with the score's cap.

import { assessLightning, type HazardAssessment } from "@/lib/hazards/assess";
import { deriveMetrics } from "@/lib/score";
import type { ConditionsResponse } from "@/lib/types";

/** A point (device-anchored) hazard read, shaped like
 *  lib/plus/client.ts's `HazardPointRead` — accepted structurally so this
 *  module doesn't need to import the React-hook-heavy client module. */
export interface LightningPointRead {
  lightning: HazardAssessment;
  /** Display-only distance the /api/hazards route measured for this anchor.
   *  HazardAssessment itself never carries a distance. */
  lightningMi: number | null;
}

export interface BeachSessionLightningState {
  active: boolean;
  latched: boolean;
  miles?: number;
  bearingDeg?: number;
  /** Epoch ms. */
  observedAt?: number;
  /** Epoch ms. */
  holdUntil?: number;
}

/** Everything ContentState needs EXCEPT `v`/`seq`/`ended`, which are about
 *  update sequencing rather than derived from conditions. */
export interface BeachSessionContentState {
  score: number;
  windMph?: number;
  gustMph?: number;
  windDeg?: number;
  waveFt?: number;
  /** "clear" | "murky" | undefined — collapsed from the finer WaterClarityGrade;
   *  see the module comment on why churned/slightly_murky both read "murky". */
  clarity?: "clear" | "murky";
  /** "low" | "moderate" | "high" | undefined — "none" is omitted rather than
   *  forced into a Swift-side bucket that doesn't exist for it. */
  seaweed?: "low" | "moderate" | "high";
  /** Epoch ms. */
  nextTideAt?: number;
  nextTideKind?: "high" | "low";
  /** Epoch ms. */
  sunsetAt?: number;
  lightning?: BeachSessionLightningState;
  /** Epoch ms. */
  updatedAt: number;
  unavailable?: boolean;
}

function epochMs(iso: string | undefined | null): number | undefined {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : undefined;
}

function mapClarity(level: string | null | undefined): "clear" | "murky" | undefined {
  if (level === "clear") return "clear";
  if (level === "slightly_murky" || level === "murky" || level === "churned") return "murky";
  return undefined;
}

function mapSeaweed(level: string | null | undefined): "low" | "moderate" | "high" | undefined {
  if (level === "low" || level === "moderate" || level === "high") return level;
  return undefined; // "none" and "unknown" both read as "nothing to show"
}

/** Build the lightning projection from an already-decided HazardAssessment +
 *  optional display-only distance/bearing. Never re-tests thresholds. */
function lightningFromAssessment(
  a: HazardAssessment,
  milesDisplay: number | null | undefined,
  bearingDeg: number | undefined,
): BeachSessionLightningState | undefined {
  if (!a.active) return undefined; // nothing to show when it isn't active
  return {
    active: a.active,
    latched: a.latched,
    miles: milesDisplay != null && Number.isFinite(milesDisplay) ? milesDisplay : undefined,
    bearingDeg,
    observedAt: epochMs(a.observedAtIso),
    holdUntil: epochMs(a.expiresAtIso),
  };
}

/**
 * Map a ConditionsResponse (+ optional device-anchored hazard reads) to the
 * Beach Session's ContentState. `lightningPoint` should be the CURRENT
 * `/api/hazards` point read when the card has one (device-anchored, matches
 * the alert engine's own anchor); otherwise this falls back to a
 * beach-anchored assessment built from `res.snapshot.lightning` via the same
 * `assessLightning` function score.ts uses — never a re-derived rule.
 * `rainPoint` is accepted for symmetry with the hazards-read shape the card
 * already holds, but Phase 2's ContentState has no rain field (see the plan's
 * Phase 4 note) — it is not used here yet.
 */
export function contentStateFromConditions(
  res: ConditionsResponse,
  opts: { nowMs: number; lightningPoint?: LightningPointRead | null; rainPoint?: unknown },
): BeachSessionContentState {
  const { nowMs, lightningPoint } = opts;
  const snap = res.snapshot;

  // Wind and waves use the SAME consensus/derived values the score itself
  // and the rest of the app show — deriveMetrics's median-of-sources wind
  // and its buoy-preferred wave reading — never a single raw source, which
  // would let the Lock Screen quietly disagree with the app (score.ts
  // deriveMetrics, checked 2026-09-22).
  const derived = deriveMetrics(snap, nowMs);
  const buoy = snap.buoy.data;
  const clarity = snap.clarity.data;
  const seaweed = snap.sargassum.data;
  const nextTide = snap.tides.data?.next?.[0];
  const sunset = snap.sun.data?.sunset;
  const sunsetMs = epochMs(sunset);

  let lightning: BeachSessionLightningState | undefined;
  if (lightningPoint) {
    lightning = lightningFromAssessment(lightningPoint.lightning, lightningPoint.lightningMi, undefined);
  } else {
    const beachLightning = snap.lightning.data;
    const assessment = assessLightning({
      status: snap.lightning.status,
      closeStrikeMinutesAgo: beachLightning?.closeStrikeMinutesAgo,
      windowMinutes: beachLightning?.windowMinutes,
      nearestMi: beachLightning?.nearestMi,
      nearestMinutesAgo: beachLightning?.nearestMinutesAgo,
      nowMs,
      anchor: { kind: "beach", slug: snap.location.slug },
    });
    lightning = lightningFromAssessment(assessment, beachLightning?.nearestMi, beachLightning?.nearestBearingDeg);
  }

  const unavailable = res.score.dataAvailable === false;
  // A degraded/stale read must not claim to be fresher than the snapshot
  // actually is — cap updatedAt at the snapshot's own generatedAt instead of
  // letting the wall clock (nowMs) advance it past what was really measured.
  const generatedAtMs = epochMs(snap.generatedAt) ?? nowMs;
  const updatedAt = unavailable ? Math.min(nowMs, generatedAtMs) : nowMs;

  return {
    score: Math.round(res.score.score),
    windMph: derived.windSpeedMph,
    // Gust only exists on BuoyData (score.ts's own merged wind is a
    // server-internal computation not exposed on ConditionsResponse) — the
    // buoy's own reading is the honest source here, absent when the buoy
    // didn't report a gust.
    gustMph: buoy?.windGustMph,
    windDeg: derived.windDirDeg,
    waveFt: derived.waveHeightFt,
    clarity: mapClarity(clarity?.level),
    seaweed: mapSeaweed(seaweed?.level),
    nextTideAt: epochMs(nextTide?.time),
    nextTideKind: nextTide?.type,
    // Once the sun has already set there is nothing left to show — omit
    // rather than display a sunset time that's now in the past.
    sunsetAt: sunsetMs != null && sunsetMs > nowMs ? sunsetMs : undefined,
    lightning,
    updatedAt,
    unavailable: unavailable ? true : undefined,
  };
}

// --- coalescing (Codex review #8) -------------------------------------------
//
// hashContentState hashes a QUANTIZED projection, not the raw values: a
// score that wobbles by a point, a wind reading that moves 1 mph, or a
// lightning distance re-estimated by a tenth of a mile is model/sensor noise,
// not something worth waking the Lock Screen for. Bucketing these fields
// before hashing is what makes "did anything meaningful change" (the
// decision table in lib/liveActivity/server/decide.ts) actually mean that.

const SCORE_BAND = 3; // ±3 pts
const WIND_BUCKET_MPH = 5;
const WAVE_STEP_FT = 0.5;
const LIGHTNING_MILES_STEP = 0.5;
const MINUTE_MS = 60_000;

function bucket(v: number | undefined, step: number): number | undefined {
  return v == null || !Number.isFinite(v) ? undefined : Math.round(v / step) * step;
}

const COMPASS_STEP_DEG = 22.5; // 360 / 16 — 16-point compass

/** windDeg is continuous (0-359.9) — a fresh forecast fetch jitters it by a
 *  fraction of a degree every run, which without quantizing here would look
 *  like a "change worth a push" every time despite the wind not having
 *  meaningfully shifted. Bucket to the 16-point compass (N, NNE, NE, ... —
 *  22.5° per point) and wrap 360 back to 0. */
function bucketCompass(v: number | undefined): number | undefined {
  if (v == null || !Number.isFinite(v)) return undefined;
  const bucketed = Math.round(v / COMPASS_STEP_DEG) * COMPASS_STEP_DEG;
  return bucketed >= 360 ? 0 : bucketed;
}

/** Tide/sunset epochs round to the minute — the second-level jitter a fresh
 *  forecast fetch reintroduces every run is not a change worth a push. */
function roundToMinute(ms: number | undefined): number | undefined {
  return ms == null || !Number.isFinite(ms) ? undefined : Math.round(ms / MINUTE_MS) * MINUTE_MS;
}

/** A stable hash of the fields that matter for "did the state change" —
 *  BeachModeCard uses this to avoid sending an update whose content is
 *  identical to what's already on the Lock Screen (excludes `updatedAt`,
 *  which always differs, and never re-adds it after quantizing everything
 *  else — the whole point is to ignore noise-level movement). */
export function hashContentState(s: BeachSessionContentState): string {
  const { updatedAt: _updatedAt, ...rest } = s;
  const quantized = {
    ...rest,
    score: bucket(rest.score, SCORE_BAND),
    windMph: bucket(rest.windMph, WIND_BUCKET_MPH),
    gustMph: bucket(rest.gustMph, WIND_BUCKET_MPH),
    windDeg: bucketCompass(rest.windDeg),
    // clarity/seaweed/nextTideKind/unavailable are already enum- or
    // step-shaped words/booleans — nothing to bucket.
    waveFt: bucket(rest.waveFt, WAVE_STEP_FT),
    nextTideAt: roundToMinute(rest.nextTideAt),
    sunsetAt: roundToMinute(rest.sunsetAt),
    lightning: rest.lightning
      ? {
          active: rest.lightning.active,
          latched: rest.lightning.latched,
          miles: bucket(rest.lightning.miles, LIGHTNING_MILES_STEP),
          bearingDeg: rest.lightning.bearingDeg,
          observedAt: roundToMinute(rest.lightning.observedAt),
          holdUntil: roundToMinute(rest.lightning.holdUntil),
        }
      : undefined,
  };
  // Every field here is built in the same fixed key order above (top level
  // and the nested `lightning` object alike), so a plain stringify is
  // already deterministic for equal values — no replacer needed.
  return JSON.stringify(quantized);
}
