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

import type { ConditionsResponse, GoesIrData } from "@/lib/types";
import {
  lowCloudClearPath,
  type CloudMix,
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
  type SunModelSource,
  type SunQualityBand,
} from "@/lib/sunQuality";

/** How close (minutes) the event must be for a "right now" satellite
 *  beam-path reading to speak for it — a live cloud observation can't vouch
 *  for a sunrise hours away. Mirrors `nearestHourlyPoint`'s forecast
 *  tolerance, same as components/SunQualityCard.tsx's own constant. */
export const BEAM_IMMINENT_MINUTES = 90;

/** The slice of the GOES wrapper this module reads: the Clear Sky Mask fields
 *  (recorded, not scored) and the cloud-top-height `ir` read (the model's
 *  primary input when fresh). Structurally compatible with `GoesCloudData`
 *  plus the wrapper's `status`. */
type GoesCloudInput =
  | { beamCloudPct?: number | null; cloudPct?: number; status?: string; ir?: GoesIrData | null }
  | null
  | undefined;

/** How old the IR granule's scan may be (vs `nowMs`) and still count as "the
 *  sky right now". The ACHA height lands ~5 min after the scan and the feed
 *  loop reads every 15 min, so 20 min is one missed cycle of slack. */
export const IR_MAX_GRANULE_AGE_MINUTES = 20;
/** The IR read speaks only for an event this close (minutes) to `nowMs`: a
 *  live observation cannot vouch for a sunrise hours away. */
export const IR_EVENT_WINDOW_MINUTES = 60;
/** The IR path read belongs to an event only if the feed's event time and the
 *  one being scored agree to within this (both come from the same NOAA solver,
 *  so they differ by seconds; the slack is for a stale golden-window pick). */
export const IR_EVENT_MATCH_MINUTES = 15;
/** Skip the IR read when fewer than this share of its cloudy pixels got a
 *  cloud-top height (the layer split would be mostly guesswork). A clear box
 *  (no cloud to classify) always passes. */
export const IR_MIN_CLASSIFIED_PCT = 60;

export type { SunModelSource };

/** A usable satellite observation for one event: the cloud mix by height, and
 *  the low cloud along the sun's path as the (verified) horizon. */
export interface IrObservation {
  cloud: CloudMix;
  horizon: HorizonPath;
  /** Which number is the horizon: the low cloud along the sun's azimuth at the
   *  event ("ir-beam"), or the overhead low share when no path read exists. */
  horizonSource: "ir-beam" | "ir-overhead";
  granuleStartIso: string;
  granuleAgeMinutes: number;
  /** Mid + high share toward the sun and away from it, along the path (null
   *  when none). Recorded for calibration; not scored. */
  sunwardMidHighPct: number | null;
  antiMidHighPct: number | null;
}

/**
 * The satellite's event-time sky for `event`, or undefined when it cannot speak
 * for it: no IR read, the granule is more than IR_MAX_GRANULE_AGE_MINUTES
 * before `nowMs`, the event is more than IR_EVENT_WINDOW_MINUTES from `nowMs`,
 * or too few of its cloudy pixels have a height. Pure.
 */
export function resolveIrObservation(
  goes: GoesCloudInput,
  event: { event: SunEventKind; timeIso: string },
  nowMs: number,
): IrObservation | undefined {
  const ir = goes?.ir;
  if (!ir) return undefined;
  const granuleMs = Date.parse(ir.granuleStartIso);
  const eventMs = Date.parse(event.timeIso);
  if (!Number.isFinite(granuleMs) || !Number.isFinite(eventMs) || !Number.isFinite(nowMs)) return undefined;
  const ageMin = (nowMs - granuleMs) / 60_000;
  // A granule a couple of minutes "after" now is clock skew between the feed
  // and the snapshot; anything further ahead is not trusted.
  if (ageMin > IR_MAX_GRANULE_AGE_MINUTES || ageMin < -2) return undefined;
  if (Math.abs(eventMs - nowMs) > IR_EVENT_WINDOW_MINUTES * 60_000) return undefined;
  if (ir.classifiedPct != null && ir.classifiedPct < IR_MIN_CLASSIFIED_PCT) return undefined;

  const path = ir.events?.[event.event];
  const pathMatches =
    !!path && Math.abs(Date.parse(path.eventIso) - eventMs) <= IR_EVENT_MATCH_MINUTES * 60_000;
  const beamLow = pathMatches ? path.beamLowPct : null;
  return {
    cloud: { lowPct: ir.lowPct, midPct: ir.midPct, highPct: ir.highPct, totalPct: ir.irCloudPct },
    horizon: { cloudPct: beamLow ?? ir.lowPct, fresh: true },
    horizonSource: beamLow != null ? "ir-beam" : "ir-overhead",
    granuleStartIso: ir.granuleStartIso,
    granuleAgeMinutes: Math.max(0, Math.round(ageMin)),
    sunwardMidHighPct: pathMatches ? path.beamMidHighPct : null,
    antiMidHighPct: pathMatches ? path.antiMidHighPct : null,
  };
}

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

/** Which satellite field fed the horizon reading: the Clear Sky Mask's sunward
 *  `beam` path, or its `overhead` cloudPct fallback (beamCloudPct is null below
 *  ~5° sun elevation — the usual case at sunrise) — both recorded only — or,
 *  when the cloud-top read is fresh and scored, `ir-beam` (low cloud along the
 *  sun's azimuth at the event) / `ir-overhead` (the IR low share overhead). */
export type HorizonSource = "beam" | "overhead" | "ir-beam" | "ir-overhead";

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
  /** The cloud mix the model was handed: the satellite's when a fresh
   *  cloud-top read speaks for the event, else the forecast point's. */
  cloud: CloudMix | undefined;
  /** What fed `cloud`: "satellite-ir", "forecast", or null (no cloud at all).
   *  Also written into `result.breakdown.source`. */
  source: SunModelSource | null;
  /** The satellite observation behind the model, when `source` is "satellite-ir". */
  ir: IrObservation | undefined;
  /** The horizon the model scored (the IR path read) or, with no fresh IR, the
   *  Clear Sky Mask horizon that is only recorded. */
  horizon: HorizonPath | undefined;
  /** Which satellite field fed `horizon` (null when there is no horizon). */
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
  const maskHorizon = resolveSunHorizonDetailed(inputs.goesCloud, event.timeIso, inputs.nowMs);

  // PRIMARY INPUT: a fresh satellite cloud-top read (GOES ACHA, works day and
  // night, tells a low deck from a mid/high one) speaks for an event within
  // IR_EVENT_WINDOW_MINUTES. Its low/mid/high shares are the cloud mix and the
  // low cloud along the sun's azimuth at the event is the horizon, scored as
  // verified. The hourly forecast is the fallback only (docs/benchmarks/
  // sun-leadtime-2026-10-15: the forecast layers missed real cloud both days).
  const ir = resolveIrObservation(inputs.goesCloud, event, inputs.nowMs);
  const cloud = ir ? ir.cloud : point?.cloud;
  const source: SunModelSource | null = ir ? "satellite-ir" : point?.cloud ? "forecast" : null;
  // Without IR the Clear Sky Mask horizon is recorded (horizon / horizonSource,
  // archived to sun_event_predictions) but NOT scored: the mask cannot tell
  // cloud heights apart, and near sunrise/sunset (sun < 5 deg) there is no
  // beam-path reading at all, so the only number available was cloud OVERHEAD
  // -- the very deck that lights up. Scoring it as "cloud blocking the
  // horizon" capped every satellite-fresh event at ~62: never "Great"
  // (2026-10-06 Boca sunrise, docs/benchmarks/2026-10-06-sun-model). The
  // horizon gap then comes from the forecast's low cloud instead.
  const horizon = ir ? ir.horizon : maskHorizon.horizon;
  const horizonSource: HorizonSource | null = ir ? ir.horizonSource : maskHorizon.source;

  const scored = sunEventQuality({
    cloud,
    humidityPct: point?.humidityPct,
    aod: inputs.airQuality?.aod,
    pm2_5: inputs.airQuality?.pm2_5,
    horizon: ir?.horizon,
  });
  // Say which source fed the model, in the breakdown the archive stores
  // (no migration: breakdown_json already holds it). The total-only path has no
  // breakdown; it only ever runs on the forecast.
  const result: SunEventQuality = scored.breakdown
    ? {
        ...scored,
        breakdown: {
          ...scored.breakdown,
          ...(source ? { source } : {}),
          ...(ir
            ? {
                satellite: {
                  granuleStartIso: ir.granuleStartIso,
                  granuleAgeMinutes: ir.granuleAgeMinutes,
                  horizon: ir.horizonSource,
                  sunwardMidHighPct: ir.sunwardMidHighPct,
                  antiMidHighPct: ir.antiMidHighPct,
                },
              }
            : {}),
        },
      }
    : scored;

  // Same rough clear-path estimate the factor model uses, purely for the
  // peak-color "reasonably clear" gate.
  const clearPathEstimate = ir
    ? Math.max(0, Math.min(100, 100 - ir.horizon.cloudPct))
    : cloud?.lowPct != null
      ? lowCloudClearPath(cloud.lowPct)
      : undefined;
  const peak = peakColorTime({
    event: event.event,
    eventIso: event.timeIso,
    peakAnchorIso: event.peakAnchorIso,
    highPct: cloud?.highPct,
    clearPathScore: clearPathEstimate,
  });

  return { point, cloud, source, ir, horizon, horizonSource, result, peak };
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
