/**
 * Shared hazard assessment — the ONE place that decides "is lightning near"
 * and "is it raining" from raw feed signals. Pure: no fetch, no clock reads
 * (nowMs is always a parameter) — score.ts and the alert engine both call
 * this so a cap and a push notification can never disagree about the same
 * moment. See docs/LOCATION_FIRST_PLAN.md phase 1a/1b.
 */

export type HazardAnchor =
  | { kind: "beach"; slug: string }
  | { kind: "point"; lat: number; lon: number; cell: string }; // cell = cellKey(lat, lon)

export interface HazardAssessment {
  kind: "lightning" | "rain";
  anchor: HazardAnchor;
  /** The cap/alert should apply now (observed now OR still inside the hold). */
  active: boolean;
  /** true when active only because of the hold window (nothing observed this instant). */
  latched: boolean;
  severity: "none" | "rain" | "storm" | "lightning-near";
  observedAtIso: string | null; // the observation the state rests on
  expiresAtIso: string | null; // when the hold lapses if nothing new is seen
  /** Short, user-facing reason, e.g. "Lightning within 5 miles, 12 min ago". */
  reason: string | null;
  /** Rain only: a FRESH, OK radar frame sees nothing now and nothing recently
   *  — confident enough to veto a nowcast/model rain signal. score.ts derives
   *  its `radarDryNow` from this so there's one formula, not two. */
  confidentDryVeto?: boolean;
}

/** Minutes a lightning cap holds after the last strike within 5 mi — the
 *  standard lightning-safety "30/30 rule". */
export const LIGHTNING_HOLD_MIN = 30;
/** Minutes a rain cap holds after radar last saw the beach wet. */
export const RAIN_HOLD_MIN = 20;

/** Radar must be this fresh for its "dry now" reading to be trusted enough
 *  to veto a nowcast/model rain signal (mirrors score.ts's prior constants). */
const RADAR_DRY_VETO_MAX_AGE_MIN = 25;
const RADAR_DRY_VETO_RADIUS_KM = 5;

/** Radar rain-rate (mm/hr) at or above which we call it "raining" — the one
 *  threshold shared by the hazard cap and the alert engine, so a 0.1 mm/hr
 *  trace can't cap the score while the alert engine still calls it dry.
 *  Mirrors RAIN_WET_MM_HR in scripts/mrms_precip.py — keep in sync. */
export const RAIN_WET_MM_HR = 0.5;

export function assessLightning(i: {
  status: string;
  /** Age (minutes) of the MOST RECENT strike within 5 mi — the ONLY signal
   *  that decides active/latched. Undefined when no strike is within 5 mi. */
  closeStrikeMinutesAgo?: number | null;
  /** Minutes of GLM data the feed actually scanned (lib/sources/lightning.ts
   *  summarizeStrikes / LightningFeed.windowMinutes). The GLM feed's window is
   *  exactly 30 min (scripts/glm_lightning.py WINDOW_MIN) — the hold below
   *  relies on windowMinutes >= LIGHTNING_HOLD_MIN, since a strike ages out of
   *  the feed entirely once it's older than the window. If a feed ever reports
   *  a narrower window, cap the effective hold so we never claim a hold the
   *  feed can't actually back with data. */
  windowMinutes?: number | null;
  /** Display only — NOT used for the active/latched decision. The closest
   *  strike can be a different strike than the most recent close one. */
  nearestMi?: number | null;
  nearestMinutesAgo?: number | null;
  nowMs: number;
  anchor: HazardAnchor;
}): HazardAssessment {
  const closeStrikeMinutesAgo = i.closeStrikeMinutesAgo ?? undefined;
  const effectiveHoldMin =
    i.windowMinutes != null && i.windowMinutes < LIGHTNING_HOLD_MIN
      ? i.windowMinutes
      : LIGHTNING_HOLD_MIN;
  // The 5-mile-line flicker this replaced came from recomputing "active" off
  // the CURRENT nearestMi every call, which toggles as triangulation noise
  // hovers a strike's distance estimate around 5 mi. closeStrikeMinutesAgo is
  // fixed to the strike itself (age only climbs), so once inside the hold it
  // can only fall out by aging past effectiveHoldMin — never by a distance
  // re-estimate.
  const active =
    i.status === "ok" && closeStrikeMinutesAgo != null && closeStrikeMinutesAgo <= effectiveHoldMin;
  // Latched = active only because we're still inside the hold window — the
  // scan interval (~5 min) has passed since the strike that triggered it.
  const latched = active && (closeStrikeMinutesAgo as number) > 5;

  let observedAtIso: string | null = null;
  let expiresAtIso: string | null = null;
  let reason: string | null = null;
  if (active) {
    const ago = closeStrikeMinutesAgo as number;
    const observedAtMs = i.nowMs - ago * 60_000;
    observedAtIso = new Date(observedAtMs).toISOString();
    expiresAtIso = new Date(observedAtMs + effectiveHoldMin * 60_000).toISOString();
    // Distance is for display only — never part of the active/latched call.
    const minAgo = Math.max(0, Math.round(i.nearestMinutesAgo ?? ago));
    const mi = i.nearestMi;
    reason =
      mi != null && Number.isFinite(mi)
        ? `Lightning ${Math.round(mi * 10) / 10} miles away, ${minAgo} min ago`
        : `Lightning within 5 miles, ${minAgo} min ago`;
  }

  return {
    kind: "lightning",
    anchor: i.anchor,
    active,
    latched,
    severity: active ? "lightning-near" : "none",
    observedAtIso,
    expiresAtIso,
    reason,
  };
}

export function assessRain(i: {
  radar: {
    status: string;
    frameAgeMinutes?: number | null;
    rainNowMmHr?: number | null;
    nearestRainKm?: number | null;
    wetMinutesAgo?: number | null;
  } | null;
  nowcastState?: "raining" | "dry" | null;
  corroborated: boolean;
  stormSignal: boolean;
  nowMs: number;
  anchor: HazardAnchor;
}): HazardAssessment {
  const radar = i.radar;
  const radarOk = !!radar && radar.status === "ok";
  const fresh = radarOk && (radar!.frameAgeMinutes ?? Infinity) <= RADAR_DRY_VETO_MAX_AGE_MIN;
  const radarWetNow =
    radarOk &&
    fresh &&
    ((radar!.rainNowMmHr ?? 0) >= RAIN_WET_MM_HR ||
      (radar!.nearestRainKm ?? Infinity) <= RADAR_DRY_VETO_RADIUS_KM);
  const wetMinutesAgo = radar?.wetMinutesAgo ?? null;
  const radarWetRecently = wetMinutesAgo != null && wetMinutesAgo <= RAIN_HOLD_MIN;
  // Confident dry veto: only a FRESH, OK radar frame that sees nothing now and
  // nothing recently may cancel a nowcast/model rain signal — a stale or
  // missing radar must never manufacture a false "all clear".
  const confidentDryVeto = radarOk && fresh && !radarWetNow && !radarWetRecently;
  const nowcastPath = i.nowcastState === "raining" && i.corroborated && !confidentDryVeto;
  const active = radarWetNow || radarWetRecently || nowcastPath;
  const latched = active && !radarWetNow && !nowcastPath;

  let observedAtIso: string | null = null;
  let expiresAtIso: string | null = null;
  let reason: string | null = null;
  if (radarWetNow || nowcastPath) {
    observedAtIso = new Date(i.nowMs).toISOString();
    expiresAtIso = new Date(i.nowMs + RAIN_HOLD_MIN * 60_000).toISOString();
    reason = "Raining right now";
  } else if (radarWetRecently) {
    const observedAtMs = i.nowMs - (wetMinutesAgo as number) * 60_000;
    observedAtIso = new Date(observedAtMs).toISOString();
    expiresAtIso = new Date(observedAtMs + RAIN_HOLD_MIN * 60_000).toISOString();
    reason = "Rain in the last 20 minutes";
  }

  const severity: HazardAssessment["severity"] = active ? (i.stormSignal ? "storm" : "rain") : "none";

  return {
    kind: "rain",
    anchor: i.anchor,
    active,
    latched,
    severity,
    observedAtIso,
    expiresAtIso,
    reason,
    confidentDryVeto,
  };
}
