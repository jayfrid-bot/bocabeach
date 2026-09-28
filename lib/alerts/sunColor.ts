// The "sun-color" alert: a heads-up when the next sunrise/sunset at a
// device's home beach is predicted to be top-tier color, sent a
// user-chosen lead time before it. Mirrors lib/alerts/morning.ts's
// `excellentDecision` shape — a small pure function that turns a
// prediction + a device's own settings into a ready `AlertDecision`, or
// null when nothing should be sent this tick.
//
// PURE — no I/O, no store, no `Date.now()`/`new Date()` (every clock is an
// explicit `nowMs` parameter, same SSR-safety rule every other alert module
// in this repo follows). `predictNextSunEvent` (lib/sunAlert.ts) does the
// one real assembly step (reading the conditions snapshot); everything here
// just decides what to do with its answer.

import type { SunEventPrediction } from "@/lib/sunAlert";
import type { DeviceRecord, SunColorMinBand } from "@/lib/db/types";
import { sunQualityBandMeta, type SunEventKind } from "@/lib/sunQuality";
import { fmtTime } from "@/lib/format";
import { localHourParts } from "@/lib/history/archive";
import { computeSunTimes } from "@/lib/sources/sun";
import { buildAlert, type AlertDecision, type SunColorSubject } from "@/lib/alerts/catalog";

/**
 * Score cutoff for the default threshold, "Great or better" — matches
 * lib/sunQuality.ts's BAND_CUTOFFS entry for the "vivid" band (label
 * "Great"): score >= 70. The owner's brief was "80-plus percentile" for
 * "top-tier color"; SUN_QUALITY_BANDS is a tuned meteorological curve, not a
 * population distribution, so there is no percentile to look up — this
 * reuses the closest already-tuned, already-shipped threshold (the Great
 * band) rather than inventing an unvalidated number. Keep in sync with
 * lib/sunQuality.ts's BAND_CUTOFFS.
 */
export const SUN_COLOR_GREAT_CUTOFF = 70;

/** Score cutoff for "Amazing only" — matches BAND_CUTOFFS' "epic" band. */
export const SUN_COLOR_AMAZING_CUTOFF = 90;

export function sunColorCutoffFor(minBand: SunColorMinBand): number {
  return minBand === "epic" ? SUN_COLOR_AMAZING_CUTOFF : SUN_COLOR_GREAT_CUTOFF;
}

/** A prediction more than this far out isn't trustworthy yet (§ requirement
 *  #3) — the forecast cloud reading for an event this far ahead is too
 *  coarse to promise a push over. This also caps how far ahead a slug is
 *  ever marked a sun-color `candidate` in `sunColorSlugNeed` below. */
export const SUN_COLOR_MAX_LEAD_MS = 4 * 60 * 60 * 1000;

/** The send window's width: `[event - lead, event - lead + 10 min)`. Wide
 *  enough that at least one of the 5-minute cron's two ticks inside it
 *  lands, per beach, but never so wide it could fire after the event (every
 *  offered lead — 30/60/120/180 min — is well over 10 min). */
export const SUN_COLOR_SEND_WINDOW_MS = 10 * 60 * 1000;

/** The `alert_log` dedup key for one event: once per event, ever — even if
 *  the score later climbs back above the cutoff after dipping below it. */
export function sunColorEventKey(kind: SunEventKind, eventIso: string): string {
  const d = new Date(eventIso);
  if (Number.isNaN(d.getTime())) return `sun-color:${kind}:invalid`;
  return `sun-color:${kind}:${d.toISOString().slice(0, 13)}`; // date-hour, e.g. "2026-09-28T22"
}

/** "about an hour" / "the next half hour" — the device's lead-time setting,
 *  worded for the push body and for the settings sheet's example line. */
export function sunColorLeadPhrase(leadMin: number): string {
  switch (leadMin) {
    case 30:
      return "the next half hour";
    case 120:
      return "about two hours";
    case 180:
      return "about three hours";
    case 60:
    default:
      return "about an hour";
  }
}

export interface SunColorAlertInput {
  device: Pick<DeviceRecord, "prefs" | "homeSlug" | "sunColor">;
  /** From `predictNextSunEvent(res, nowMs)` — null when there's no sun-times
   *  reading for this beach right now. */
  prediction: SunEventPrediction | null;
  beachName: string;
  tz: string;
  nowMs: number;
}

/**
 * Decide whether to send the sun-color alert to one device this tick.
 * Requirement #3's send rule: score >= the device's own cutoff, AND `now`
 * is within `[event - lead, event - lead + 10 min)`, AND the predicted
 * event is <= 4h away (a farther-out prediction isn't trustworthy yet).
 * Returns a ready `AlertDecision` (title/body/tag/dedupKey) or null.
 */
export function sunColorDecision(input: SunColorAlertInput): AlertDecision | null {
  const { device, prediction, beachName, tz, nowMs } = input;
  if (device.prefs["sun-color"] !== true) return null;
  if (!device.homeSlug) return null;
  if (!prediction || prediction.score == null || prediction.band == null) return null;

  const cutoff = sunColorCutoffFor(device.sunColor.minBand);
  if (prediction.score < cutoff) return null;

  const eventMs = Date.parse(prediction.eventIso);
  if (!Number.isFinite(eventMs)) return null;
  if (eventMs - nowMs > SUN_COLOR_MAX_LEAD_MS) return null; // too far out to trust yet

  const leadMs = device.sunColor.leadMin * 60_000;
  const windowStart = eventMs - leadMs;
  const windowEnd = windowStart + SUN_COLOR_SEND_WINDOW_MS;
  if (nowMs < windowStart || nowMs >= windowEnd) return null; // outside the send window (windowEnd is always < eventMs, so this also guards "never after the event")

  const bandLabel = sunQualityBandMeta(prediction.band).label; // "Great" | "Amazing"
  const subject: SunColorSubject = {
    key: "sun-color",
    kind: prediction.kind,
    bandLabel,
    eventLabel: `${prediction.kind} ${fmtTime(prediction.eventIso, tz)}`,
    peakLabel: fmtTime(prediction.peakIso, tz),
    leadPhrase: sunColorLeadPhrase(device.sunColor.leadMin),
    eventKey: sunColorEventKey(prediction.kind, prediction.eventIso),
  };
  return buildAlert(subject, { beach: beachName });
}

/** A cheap, fetch-free estimate of the next sun event's kind + instant, off
 *  `computeSunTimes` (lib/sources/sun.ts, pure — no network) rather than a
 *  full conditions build. Mirrors `lib/sunQuality.ts`'s `nextSunEvent`
 *  precedence (today's sunrise if it hasn't happened, else today's sunset,
 *  else tomorrow's sunrise) using real Date objects instead of ISO strings.
 *  Used only to decide whether a beach's group is worth fetching conditions
 *  for this tick — `predictNextSunEvent` (lib/sunAlert.ts) is the real,
 *  scored answer once conditions ARE on hand. */
export function nextSunEventEstimate(
  loc: { lat: number; lon: number; timezone: string },
  nowMs: number,
): { kind: SunEventKind; eventMs: number } | null {
  const today = localHourParts(loc.timezone, nowMs).date; // "YYYY-MM-DD", beach-local
  const [y, m, d] = today.split("-").map(Number);
  const t = computeSunTimes(loc.lat, loc.lon, y, m, d);
  if (t.sunrise && nowMs < t.sunrise.getTime()) return { kind: "sunrise", eventMs: t.sunrise.getTime() };
  if (t.sunset && nowMs < t.sunset.getTime()) return { kind: "sunset", eventMs: t.sunset.getTime() };
  const tmr = new Date(Date.UTC(y, m - 1, d + 1));
  const t2 = computeSunTimes(loc.lat, loc.lon, tmr.getUTCFullYear(), tmr.getUTCMonth() + 1, tmr.getUTCDate());
  if (t2.sunrise) return { kind: "sunrise", eventMs: t2.sunrise.getTime() };
  return null;
}

/**
 * Does a device's home beach need its conditions fetched this tick, purely
 * for the sun-color alert? `candidate` (elastic — fine to pick up next
 * tick) whenever the next event is 0-4h away; `due` (must not be starved)
 * only once inside the actual send window, mirroring
 * app/api/push/run/route.ts's `slugConditionsNeed` "due vs candidate"
 * split for score-excellent/coming-up. Computed WITHOUT fetching
 * conditions (Requirement #3's budget rule) — `computeSunTimes` is pure.
 */
export function sunColorSlugNeed(
  loc: { lat: number; lon: number; timezone: string },
  device: Pick<DeviceRecord, "prefs" | "homeSlug" | "sunColor">,
  nowMs: number,
): { due: boolean; candidate: boolean } {
  if (device.prefs["sun-color"] !== true || !device.homeSlug) return { due: false, candidate: false };
  const next = nextSunEventEstimate(loc, nowMs);
  if (!next) return { due: false, candidate: false };
  const aheadMs = next.eventMs - nowMs;
  if (aheadMs < 0 || aheadMs > SUN_COLOR_MAX_LEAD_MS) return { due: false, candidate: false };

  const leadMs = device.sunColor.leadMin * 60_000;
  const windowStart = next.eventMs - leadMs;
  const windowEnd = windowStart + SUN_COLOR_SEND_WINDOW_MS;
  const due = nowMs >= windowStart && nowMs < windowEnd;
  return { due, candidate: true };
}
