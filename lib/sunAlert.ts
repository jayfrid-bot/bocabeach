// Server-usable sunrise/sunset color prediction — the SAME assembly
// components/SunQualityCard.tsx calls for its own render (nearest hourly
// cloud/humidity reading, current air quality, a fresh-and-imminent
// satellite horizon reading), so the "sun-color" push alert
// (lib/alerts/sunColor.ts, app/api/push/run/route.ts) can never quietly
// disagree with what the card itself would show for the same beach at the
// same instant. `assembleSunEventQuality` is the ONE function both call —
// the card imports it directly (see components/SunQualityCard.tsx) rather
// than keeping its own parallel copy.
//
// Pure: no I/O, no clock reads (`nowMs` is always passed in).

import type { ConditionsResponse } from "@/lib/types";
import {
  nearestHourlyPoint,
  nextSunEvent,
  peakColorTime,
  sunEventQuality,
  type GoldenWindowIso,
  type HorizonPath,
  type HourlyCloudPoint,
  type PeakColorTime,
  type SunEventKind,
  type SunEventQuality,
  type SunEventTime,
  type SunEventTimes,
  type SunQualityBand,
} from "@/lib/sunQuality";

/** How close (minutes) the event must be for a "right now" satellite
 *  beam-path reading to speak for it — a live cloud observation can't vouch
 *  for a sunrise hours away. Mirrors `nearestHourlyPoint`'s forecast
 *  tolerance, same as components/SunQualityCard.tsx's own constant. */
export const BEAM_IMMINENT_MINUTES = 90;

type GoesCloudInput = { beamCloudPct?: number | null; cloudPct?: number; status?: string } | null | undefined;

/**
 * Resolve the satellite beam/horizon-path clearness for the factor model —
 * present (with `fresh: true`) only when GOES delivered a reading, its
 * wrapper is "ok" (not stale), and the event is within
 * `BEAM_IMMINENT_MINUTES` of `nowMs`. Beam-path cloud is preferred; overhead
 * `cloudPct` is the honest fallback.
 */
export function resolveSunHorizon(
  goes: GoesCloudInput,
  eventIso: string,
  nowMs: number,
): HorizonPath | undefined {
  return resolveSunHorizonDetailed(goes, eventIso, nowMs).horizon;
}

/** Which satellite field fed the horizon reading: the sunward `beam` path, or
 *  the `overhead` cloudPct fallback (beamCloudPct is null below ~5° sun
 *  elevation — the usual case at sunrise). */
export type HorizonSource = "beam" | "overhead";

/**
 * `resolveSunHorizon` plus WHICH field supplied the number — recording only
 * (the history archiver stores it); the horizon value is exactly what
 * `resolveSunHorizon` always returned.
 */
export function resolveSunHorizonDetailed(
  goes: GoesCloudInput,
  eventIso: string,
  nowMs: number,
): { horizon: HorizonPath | undefined; source: HorizonSource | null } {
  if (!goes || goes.status !== "ok") return { horizon: undefined, source: null };
  const pct = goes.beamCloudPct ?? goes.cloudPct;
  if (pct == null) return { horizon: undefined, source: null };
  const dt = Math.abs(Date.parse(eventIso) - nowMs);
  if (!Number.isFinite(dt)) return { horizon: undefined, source: null };
  const fresh = dt <= BEAM_IMMINENT_MINUTES * 60_000;
  return {
    horizon: { cloudPct: pct, fresh },
    source: goes.beamCloudPct != null ? "beam" : "overhead",
  };
}

/** The slice of an hourly forecast point this module reads — structurally
 *  compatible with `lib/types.ts`'s `HourlyMetrics`, so a real snapshot's
 *  `hourly.data` passes straight through. */
export interface SunAlertHourlyPoint {
  time: string;
  cloudCoverLowPct?: number;
  cloudCoverMidPct?: number;
  cloudCoverHighPct?: number;
  cloudCoverPct?: number;
  humidityPct?: number;
}

/** Map the raw hourly forecast into `sunEventQuality`'s cloud/humidity
 *  points — the same shape components/ConditionsDashboard.tsx builds
 *  (`sunQualityHourly`) for the card. */
export function sunQualityHourlyPoints(
  hourly: readonly SunAlertHourlyPoint[] | null | undefined,
): HourlyCloudPoint[] {
  return (hourly ?? []).map((h) => ({
    time: h.time,
    cloud: {
      lowPct: h.cloudCoverLowPct,
      midPct: h.cloudCoverMidPct,
      highPct: h.cloudCoverHighPct,
      totalPct: h.cloudCoverPct,
    },
    humidityPct: h.humidityPct,
  }));
}

export interface SunEventAssembly {
  /** The nearest hourly forecast point to the event, when one is within
   *  tolerance (see `nearestHourlyPoint`). */
  point: HourlyCloudPoint | undefined;
  horizon: HorizonPath | undefined;
  /** Which satellite field fed `horizon` (null when there is no horizon).
   *  Recording only — the history archiver stores it. */
  horizonSource: HorizonSource | null;
  /** Score/band/note/breakdown — see `lib/sunQuality.ts`'s `sunEventQuality`. */
  result: SunEventQuality;
  peak: PeakColorTime | null;
}

/**
 * Given an ALREADY-CHOSEN sun event (the card picks its own via
 * `goldenHourTiming`'s richer timing engine; `predictNextSunEvent` below
 * picks its own via the plain `nextSunEvent`), read the cloud/air/horizon
 * signals and score it. This is the piece that was genuinely duplicated
 * between the card and the alert — now the one place either of them touches
 * `nearestHourlyPoint`/`sunEventQuality`/`peakColorTime`/`resolveSunHorizon`
 * directly.
 */
export function assembleSunEventQuality(
  event: Pick<SunEventTime, "event" | "timeIso" | "peakAnchorIso">,
  inputs: {
    hourly: readonly HourlyCloudPoint[];
    airQuality?: { aod?: number; pm2_5?: number } | null;
    goesCloud?: GoesCloudInput;
    nowMs: number;
  },
): SunEventAssembly {
  const point = nearestHourlyPoint(event.timeIso, inputs.hourly);
  const { horizon, source: horizonSource } = resolveSunHorizonDetailed(
    inputs.goesCloud,
    event.timeIso,
    inputs.nowMs,
  );

  // The satellite reading is recorded (horizon / horizonSource, archived to
  // sun_event_predictions) but NOT scored. The GOES clear-sky mask cannot
  // tell cloud heights apart, and near sunrise/sunset (sun < 5°) there is no
  // beam-path reading at all, so the only number available was cloud
  // OVERHEAD — the very deck that lights up. Scoring it as "cloud blocking
  // the horizon" capped every satellite-fresh event at ~62: never "Great"
  // (2026-10-06 Boca sunrise, docs/benchmarks/2026-10-06-sun-model). The
  // horizon gap comes from the forecast's low cloud instead.
  const result = sunEventQuality({
    cloud: point?.cloud,
    humidityPct: point?.humidityPct,
    aod: inputs.airQuality?.aod,
    pm2_5: inputs.airQuality?.pm2_5,
  });

  // Same rough clear-path estimate the factor model uses, purely for the
  // peak-color "reasonably clear" gate.
  const clearPathEstimate =
    point?.cloud.lowPct != null ? Math.max(0, 100 - point.cloud.lowPct * 1.1) : undefined;
  const peak = peakColorTime({
    event: event.event,
    eventIso: event.timeIso,
    peakAnchorIso: event.peakAnchorIso,
    highPct: point?.cloud.highPct,
    clearPathScore: clearPathEstimate,
  });

  return { point, horizon, horizonSource, result, peak };
}

export interface SunEventPrediction {
  kind: SunEventKind;
  /** ISO instant of the event itself. */
  eventIso: string;
  /** ISO instant of the estimated peak-color moment — equals `eventIso` when
   *  there's no high-cloud deck to lag it. */
  peakIso: string;
  /** 0-100, or null when there's no forecast cloud reading for the event
   *  hour yet. */
  score: number | null;
  band: SunQualityBand | null;
}

/**
 * The next sunrise/sunset at this beach, and how colorful it should be —
 * picks the event with the plain `nextSunEvent` (never the card's richer
 * golden-window-aware `scored` target — that's a display refinement, not a
 * different event), then scores it with the SAME `assembleSunEventQuality`
 * the card calls. Returns null when there's no sun-times reading for this
 * beach at all, or no next event to pick.
 *
 * `nowMs` should be the conditions snapshot's OWN `generatedAt` (Requirement
 * item 4), not the caller's wall clock — that is what makes the GOES
 * freshness check (and the "next event" pick, on a served-from-cache
 * snapshot) agree with what the card would show for that exact snapshot;
 * SSR and this alert both judge freshness relative to when the data was
 * actually generated. The caller (app/api/push/run/route.ts) uses the real
 * wall clock separately, only for the send-window decision
 * (`lib/alerts/sunColor.ts`'s `sunColorDecision`).
 */
export function predictNextSunEvent(res: ConditionsResponse, nowMs: number): SunEventPrediction | null {
  const snap = res.snapshot;
  const sun = snap.sun?.data;
  if (!sun) return null;

  const today: SunEventTimes = {
    sunrise: sun.sunrise,
    sunset: sun.sunset,
    goldenAm: {
      goldenStartIso: sun.goldenAmStartIso,
      goldenEndIso: sun.goldenAmEndIso,
      peakAnchorIso: sun.goldenAmPeakIso,
    },
    goldenEve: {
      goldenStartIso: sun.goldenEveStartIso,
      goldenEndIso: sun.goldenEveEndIso,
      peakAnchorIso: sun.goldenEvePeakIso,
    },
  };
  const tomorrow: { sunriseIso?: string; goldenAm?: GoldenWindowIso } = {
    sunriseIso: sun.tomorrowSunrise,
    goldenAm: {
      goldenStartIso: sun.tomorrowGoldenAmStartIso,
      goldenEndIso: sun.tomorrowGoldenAmEndIso,
      peakAnchorIso: sun.tomorrowGoldenAmPeakIso,
    },
  };

  const next = nextSunEvent(new Date(nowMs), today, tomorrow);
  if (!next) return null;

  const hourly = sunQualityHourlyPoints(snap.hourly?.data);
  const goes = snap.goesCloud?.data
    ? { ...snap.goesCloud.data, status: snap.goesCloud.status }
    : null;
  const { result, peak } = assembleSunEventQuality(next, {
    hourly,
    airQuality: snap.airQuality?.data,
    goesCloud: goes,
    nowMs,
  });

  return {
    kind: next.event,
    eventIso: next.timeIso,
    peakIso: peak?.iso ?? next.timeIso,
    score: result.score,
    band: result.band,
  };
}
