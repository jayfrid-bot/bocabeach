import type { PrecipRadarData, Wrapped } from "@/lib/types";
import { degToCardinal } from "@/lib/util";

/**
 * Turn the MRMS radar feed into one honest line of user copy.
 *
 * INFORMATIONAL ONLY (v1): nothing here touches the Beach Day score or its rain
 * caps. It produces display copy and nothing else.
 *
 * The whole point of this module is that a radar mosaic is an OBSERVATION,
 * so it gets to speak plainly ("Raining at the beach now") where the model-based
 * nowcast can only hedge. That authority is exactly why it must go SILENT the
 * moment it stops being current — a confidently-worded "rain in ~20 min" built
 * on a 40-minute-old frame is worse than saying nothing, because users trust
 * observations more than forecasts. Hence: null on stale, null on missing, null
 * on a quiet radar box.
 */

/** Radar rain-rate (mm/hr) at or above which we call it "raining". Mirrors
 *  RAIN_MM_HR in scripts/mrms_precip.py — the same threshold the job uses for
 *  coverage/nearest, kept in sync so the copy can't disagree with the numbers
 *  it's describing. */
export const RAIN_MM_HR = 0.5;

/** Above this ETA we stop calling it "approaching": beyond ~45 min a radar
 *  extrapolation is no better than the hourly forecast the app already shows,
 *  and cells routinely grow, decay, or turn in that time. The job caps ETA at
 *  60 min; this is the tighter bar for actually SAYING something about it. */
export const APPROACHING_MAX_MINUTES = 45;

/** Rain further away than this isn't worth a "showers nearby" mention — it's
 *  most of the way to the edge of the ~64 km analysis box. */
const NEARBY_MAX_MI = 30;

const KM_PER_MI = 1.609344;

export type RainNowcastKind = "raining" | "approaching" | "nearby";

export interface RainNowcast {
  kind: RainNowcastKind;
  /** One line of ready-to-render copy. */
  text: string;
  /** Distance to the rain in miles (absent when it's raining at the beach). */
  distanceMi?: number;
  /** Minutes until arrival — only on `approaching`. */
  etaMinutes?: number;
}

const kmToMi = (km: number): number => km / KM_PER_MI;

/** Round to a whole mile, but never to 0 — "0 mi away" reads as a bug when the
 *  radar means "very close but not on top of you". */
function miles(km: number): number {
  return Math.max(1, Math.round(kmToMi(km)));
}

/** Whether the rain field is carrying the nearest cell roughly TOWARD the
 *  beach. Used only to pick honest wording for the nearby-not-approaching case
 *  ("drifting away" vs a neutral "nearby") — the actual arrival decision is the
 *  job's ETA, which does the real upstream-track math. */
function movingAway(bearingToRainDeg: number, motionDirDeg: number): boolean {
  // `bearingToRainDeg` points FROM the beach TO the rain, so a cell continuing
  // along that same bearing is heading further out — away from us. (To come
  // toward us it would have to travel the REVERSE, bearing + 180.) So the rain
  // is leaving when its motion is within 90 deg of the outbound bearing.
  const diff = Math.abs(((motionDirDeg - bearingToRainDeg + 540) % 360) - 180);
  return diff < 90;
}

/**
 * The single public entry point: a Wrapped radar feed in, one line of copy or
 * null out.
 *
 * Returns null (render nothing) when:
 *  - the fetch failed, or the feed is stale (see PRECIP_RADAR_STALE_MINUTES) —
 *    an observation that isn't current has no business sounding certain;
 *  - the radar can't see this beach (rainNowMmHr null, no nearest rain);
 *  - the box is simply dry — silence IS the message, and the existing dry chip
 *    already covers "no rain expected".
 */
export function rainNowcast(w: Wrapped<PrecipRadarData> | null | undefined): RainNowcast | null {
  if (!w || w.status !== "ok" || !w.data) return null;
  const d = w.data;

  // 1. Raining here, observed. Outranks everything else — no hedging needed.
  if (d.rainNowMmHr != null && d.rainNowMmHr >= RAIN_MM_HR) {
    return { kind: "raining", text: "Raining at the beach now (radar)" };
  }

  // Everything below needs to know WHERE the rain is.
  if (d.nearestRainKm == null) return null;
  const mi = miles(d.nearestRainKm);
  if (mi > NEARBY_MAX_MI) return null;

  // A bearing is null when the rain is at the beach itself; that case is
  // already handled above, so treat a missing bearing as "no direction to
  // name" and fall back to distance-only copy rather than inventing one.
  const dir = d.nearestBearingDeg != null ? degToCardinal(d.nearestBearingDeg) : null;
  const where = dir ? `~${mi} mi ${dir}` : `~${mi} mi away`;

  // 2. Approaching: the job's upstream-track math found rain that will arrive.
  if (d.etaMinutes != null && d.etaMinutes <= APPROACHING_MAX_MINUTES) {
    return {
      kind: "approaching",
      text: `Rain on radar ${where} — could reach the beach in ~${Math.round(d.etaMinutes)} min`,
      distanceMi: mi,
      etaMinutes: Math.round(d.etaMinutes),
    };
  }

  // 3. Nearby, but not arriving inside the window we're willing to promise.
  // Two genuinely different situations share this branch, and they must not be
  // worded the same way:
  //  - there IS an ETA, just beyond APPROACHING_MAX_MINUTES: saying "not headed
  //    here" would be flatly wrong, so stay neutral about intent;
  //  - there's no ETA at all: the upstream track is dry, so the rain really is
  //    passing by — say so, using the motion vector to pick "drifting away"
  //    when it's measurably outbound.
  const tail =
    d.etaMinutes != null
      ? "" // a real but distant arrival — describe position only, promise nothing
      : d.motion != null && d.nearestBearingDeg != null && movingAway(d.nearestBearingDeg, d.motion.dirDeg)
        ? ", drifting away"
        : ", not headed here";
  return {
    kind: "nearby",
    text: `Showers on radar ${where}${tail}`,
    distanceMi: mi,
  };
}
