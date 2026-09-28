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
import type { DeviceRecord, SentState, SunColorMinBand } from "@/lib/db/types";
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

/** A prediction more than this far out isn't trustworthy yet (Requirement
 *  #3) — the forecast cloud reading for an event this far ahead is too
 *  coarse to promise a push over. */
export const SUN_COLOR_MAX_LEAD_MS = 4 * 60 * 60 * 1000;

/**
 * The send window's width: `[event - lead, event - lead + 10 min)`. Back to
 * 10 min (round-2 item 4 reverts round-1's 15-minute widening) — a
 * transient send failure releases its claim immediately
 * (`store.releaseSend`) rather than waiting out `ABANDONED_CLAIM_MS`, so
 * the 5-minute cron's very next tick can already retry; the window no
 * longer needs to be wider than that to cover the retry. A 15-minute
 * window also meant a 30-minute lead effectively fired "15 min before" —
 * too far from what the device actually chose.
 */
export const SUN_COLOR_SEND_WINDOW_MS = 10 * 60 * 1000;

/** `slugConditionsNeed`'s pure estimate (`nextSunEventEstimate`, off
 *  `computeSunTimes`) and the real decision (off the conditions snapshot's
 *  own `sun.data`) can disagree by a few minutes — different solar-position
 *  evaluations of "now". This widens the estimate's OWN window check on the
 *  END only (round-2 item 4 — never the START: selecting a beach BEFORE
 *  its window has genuinely opened would burn a capacity slot early, and
 *  `releaseSend`'s immediate retry already covers a transient failure
 *  without needing extra room at the front) so a few minutes of
 *  disagreement can't leave the real event un-fetched right at the close of
 *  its window. Does not change `sunColorDecision`'s own, exact window. */
export const SUN_COLOR_ESTIMATE_WINDOW_END_TOLERANCE_MS = 5 * 60 * 1000;

/** Same idea for the 4-hour "worth fetching at all" horizon — the estimate
 *  side gets a little extra room so a beach isn't dropped from `candidate`
 *  status moments before the real prediction would have picked it up. */
export const SUN_COLOR_ESTIMATE_HORIZON_TOLERANCE_MS = 15 * 60 * 1000;

/** The send window for one event/lead pair, as `[start, end)` epoch ms. */
export function sunColorSendWindow(eventMs: number, leadMin: number): { start: number; end: number } {
  const start = eventMs - leadMin * 60_000;
  return { start, end: start + SUN_COLOR_SEND_WINDOW_MS };
}

/** Is `nowMs` inside this prediction's own send window, for this device's
 *  lead-time setting? Exact (no tolerance) — this is the real decision's
 *  own gate, used both by `sunColorDecision` and by the route to decide
 *  whether to evaluate (and mark "checked") a device this run. */
export function sunColorInWindow(
  prediction: Pick<SunEventPrediction, "eventIso"> | null,
  leadMin: number,
  nowMs: number,
): boolean {
  if (!prediction) return false;
  const eventMs = Date.parse(prediction.eventIso);
  if (!Number.isFinite(eventMs)) return false;
  const { start, end } = sunColorSendWindow(eventMs, leadMin);
  return nowMs >= start && nowMs < end;
}

/**
 * The `alert_log` dedup key AND the "checked" latch key for one event:
 * `sun-color:<kind>:<beach-local YYYY-MM-DD>` (round-2 item 3) — each kind
 * happens once per beach-local calendar day, so this single identity stays
 * stable even when the pure estimate (`nextSunEventEstimate`) and the real
 * conditions snapshot disagree by a few minutes or straddle a UTC-hour
 * boundary — the earlier date-HOUR granularity could break on exactly that
 * (an event a few minutes into a different UTC hour than the estimate
 * expected). Once per event, ever — even if the score later climbs back
 * above the cutoff after dipping below it.
 */
export function sunColorEventKey(kind: SunEventKind, eventIso: string, tz: string): string {
  const ms = Date.parse(eventIso);
  if (!Number.isFinite(ms)) return `sun-color:${kind}:invalid`;
  const date = localHourParts(tz, ms).date; // beach-local "YYYY-MM-DD"
  return `sun-color:${kind}:${date}`;
}

/**
 * The ESTIMATE's own event identity — `nextSunEventEstimate` +
 * `sunColorEventKey`, in one call, so the route's own "checked" latch
 * (app/api/push/run/route.ts) computes it the exact same way
 * `sunColorSlugNeed` does (round-2 item 3), and the two can never
 * disagree about which event a `sunColorCheckedKey` names. This is
 * DELIBERATELY separate from `sunColorDecision`'s own dedupKey (built off
 * the real conditions snapshot) — the two may legitimately differ at a
 * boundary (the snapshot's true event lands on a different local day, or
 * even a different kind, than the estimate expected); the LATCH always
 * uses this estimate-based identity (so the selector stops re-selecting
 * this beach for the event it evaluated), while the DEDUPE that actually
 * guards against a double SEND always uses the snapshot's own true event.
 * Null only when there's truly no next event to estimate (never reachable
 * for a real served beach).
 */
export function sunColorEstimateKey(
  loc: { lat: number; lon: number; timezone: string },
  nowMs: number,
): string | null {
  const next = nextSunEventEstimate(loc, nowMs);
  if (!next) return null;
  return sunColorEventKey(next.kind, new Date(next.eventMs).toISOString(), loc.timezone);
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
  /** From `predictNextSunEvent(res, generatedAtMs)` — null when there's no
   *  sun-times reading for this beach right now. */
  prediction: SunEventPrediction | null;
  beachName: string;
  tz: string;
  /** The real wall clock — the send-window decision is about whether to
   *  push RIGHT NOW, unlike `prediction`'s own scoring clock (the
   *  snapshot's `generatedAt` — see lib/sunAlert.ts's doc, Requirement
   *  item 4). */
  nowMs: number;
}

/**
 * Decide whether to send the sun-color alert to one device this tick.
 * Score >= the device's own cutoff, AND `now` is within
 * `[event - lead, event - lead + 10 min)`, AND the predicted event is <= 4h
 * away (a farther-out prediction isn't trustworthy yet). Returns a ready
 * `AlertDecision` (title/body/tag/dedupKey) or null.
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
  if (!sunColorInWindow(prediction, device.sunColor.leadMin, nowMs)) return null;

  const bandLabel = sunQualityBandMeta(prediction.band).label; // "Great" | "Amazing"
  const subject: SunColorSubject = {
    key: "sun-color",
    kind: prediction.kind,
    bandLabel,
    eventTimeLabel: fmtTime(prediction.eventIso, tz),
    peakLabel: fmtTime(prediction.peakIso, tz),
    leadPhrase: sunColorLeadPhrase(device.sunColor.leadMin),
    eventKey: sunColorEventKey(prediction.kind, prediction.eventIso, tz),
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

export interface SunColorSlugNeed {
  due: boolean;
  candidate: boolean;
  /** The estimated dedupe key for the device's next event, whenever one
   *  exists — null only when there's truly no next event to estimate
   *  (never reachable for a real served beach). The caller
   *  (app/api/push/run/route.ts) uses this to check `alert_log` (once,
   *  only when `due || candidate`) without this module needing the store. */
  eventKey: string | null;
}

/**
 * Does a device's home beach need its conditions fetched this tick, purely
 * for the sun-color alert? `candidate` (elastic — fine to pick up next
 * tick) whenever the next event is within roughly 4h (a little slack on the
 * FAR side only — `SUN_COLOR_ESTIMATE_HORIZON_TOLERANCE_MS`); `due` (must
 * not be starved) only once inside the actual send window, with a little
 * slack on the window's END only (`SUN_COLOR_ESTIMATE_WINDOW_END_TOLERANCE_MS`)
 * — NEVER on the start (round-2 item 4: selecting a beach before its window
 * has genuinely opened, even by the estimate's own reckoning, would burn a
 * capacity slot early; `releaseSend`'s immediate retry already covers a
 * transient failure without needing that). Mirrors
 * app/api/push/run/route.ts's `slugConditionsNeed` "due vs candidate" split
 * for score-excellent/coming-up. Computed WITHOUT fetching conditions —
 * `computeSunTimes` is pure. Neither flag is ever true once this device's
 * own `sunColorCheckedKey` already names the SAME event (Codex review item
 * 2) — the round-robin must move on to a beach that still needs a look, not
 * keep re-selecting one this device has nothing further to say about this
 * hour.
 */
export function sunColorSlugNeed(
  loc: { lat: number; lon: number; timezone: string },
  device: Pick<DeviceRecord, "prefs" | "homeSlug" | "sunColor">,
  sent: Pick<SentState, "sunColorCheckedKey">,
  nowMs: number,
): SunColorSlugNeed {
  if (device.prefs["sun-color"] !== true || !device.homeSlug) {
    return { due: false, candidate: false, eventKey: null };
  }
  const next = nextSunEventEstimate(loc, nowMs);
  if (!next) return { due: false, candidate: false, eventKey: null };

  const eventKey = sunColorEventKey(next.kind, new Date(next.eventMs).toISOString(), loc.timezone);
  if (sent.sunColorCheckedKey === eventKey) return { due: false, candidate: false, eventKey };

  const aheadMs = next.eventMs - nowMs;
  // No slack on the near/negative side: an event the estimate already
  // considers past is never a candidate — nothing to gain from fetching for
  // it, and (round-2 item 4) no reason to select early in the other
  // direction either.
  if (aheadMs < 0 || aheadMs > SUN_COLOR_MAX_LEAD_MS + SUN_COLOR_ESTIMATE_HORIZON_TOLERANCE_MS) {
    return { due: false, candidate: false, eventKey };
  }

  const { start, end } = sunColorSendWindow(next.eventMs, device.sunColor.leadMin);
  const due = nowMs >= start && nowMs < end + SUN_COLOR_ESTIMATE_WINDOW_END_TOLERANCE_MS;
  return { due, candidate: true, eventKey };
}
