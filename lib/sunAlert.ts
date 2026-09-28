// Server-usable sunrise/sunset color prediction — the SAME assembly
// components/SunQualityCard.tsx does for its own render (golden-window sun
// times, the nearest hourly cloud/humidity reading, current air quality, and
// a fresh-and-imminent satellite horizon reading), extracted here so the
// "sun-color" push alert (lib/alerts/sunColor.ts, app/api/push/run/route.ts)
// reads off the exact same logic instead of a second, drifting copy of it.
// The card imports `resolveSunHorizon`/`BEAM_IMMINENT_MINUTES` from here too
// — see components/SunQualityCard.tsx.
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
  type SunEventKind,
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
 * `cloudPct` is the honest fallback. The exact rule
 * components/SunQualityCard.tsx uses for its own render.
 */
export function resolveSunHorizon(
  goes: GoesCloudInput,
  eventIso: string,
  nowMs: number,
): HorizonPath | undefined {
  if (!goes || goes.status !== "ok") return undefined;
  const pct = goes.beamCloudPct ?? goes.cloudPct;
  if (pct == null) return undefined;
  const dt = Math.abs(Date.parse(eventIso) - nowMs);
  if (!Number.isFinite(dt)) return undefined;
  const fresh = dt <= BEAM_IMMINENT_MINUTES * 60_000;
  return { cloudPct: pct, fresh };
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

export interface SunEventPrediction {
  kind: SunEventKind;
  /** ISO instant of the event itself. */
  eventIso: string;
  /** ISO instant of the estimated peak-color moment — equals `eventIso` when
   *  there's no high-cloud deck to lag it (see `lib/sunQuality.ts`'s
   *  `peakColorTime`). */
  peakIso: string;
  /** 0-100, or null when there's no forecast cloud reading for the event
   *  hour yet — see `lib/sunQuality.ts`'s `sunEventQuality`. */
  score: number | null;
  band: SunQualityBand | null;
}

/**
 * The next sunrise/sunset at this beach, and how colorful it should be —
 * assembled from a `ConditionsResponse` exactly the way
 * components/SunQualityCard.tsx does for its own render, so the "sun-color"
 * push alert can never quietly disagree with what the card itself would
 * show for the same beach at the same instant. Returns null when there's no
 * sun-times reading for this beach at all (a fetch failure with no
 * fallback) or no next event to pick (see `nextSunEvent`).
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
  const point = nearestHourlyPoint(next.timeIso, hourly);
  const goes = snap.goesCloud?.data
    ? { ...snap.goesCloud.data, status: snap.goesCloud.status }
    : null;
  const horizon = resolveSunHorizon(goes, next.timeIso, nowMs);

  const result = sunEventQuality({
    cloud: point?.cloud,
    humidityPct: point?.humidityPct,
    aod: snap.airQuality?.data?.aod,
    pm2_5: snap.airQuality?.data?.pm2_5,
    horizon,
  });

  // Same rough clear-path estimate the card uses purely for the peak-color
  // "reasonably clear" gate — mirrors the factor model's clearPath: fresh
  // beam, else a low-cloud estimate.
  const clearPathEstimate = horizon?.fresh
    ? Math.max(0, 100 - horizon.cloudPct)
    : point?.cloud.lowPct != null
      ? Math.max(0, 100 - point.cloud.lowPct * 1.1)
      : undefined;
  const peak = peakColorTime({
    event: next.event,
    eventIso: next.timeIso,
    peakAnchorIso: next.peakAnchorIso,
    highPct: point?.cloud.highPct,
    clearPathScore: clearPathEstimate,
  });

  return {
    kind: next.event,
    eventIso: next.timeIso,
    peakIso: peak?.iso ?? next.timeIso,
    score: result.score,
    band: result.band,
  };
}
