// The "coming-up" sky-events alert: eligibility windows, priority selection,
// and copy-subject building for the ONE new alert key (docs/SKY_EVENTS_PLAN.md
// §10). Crew G / Phase 3.
//
// PURE — no I/O, no store, no Date.now()/new Date() (every clock is an
// explicit `nowMs`/`windowStart`/`windowEnd` parameter, same SSR-safety rule
// every other sky-events module follows). This module never fetches
// anything itself: `lib/conditions.ts` (INTEGRATION's work, another crew's
// file — not touched here) already merges the four Phase-1 adapters into one
// per-beach set of sky events, once per conditions build —
// app/api/push/run/route.ts's home-digest loop already has that value on
// hand for any slug it visits, so there is nothing left for this module to
// fetch (§9: "never extra full-conditions builds for sky alerts").
//
// Selects from the UNCAPPED candidate list (every alert-relevant SkyEvent
// the conditions build produced for this beach), not from the "Coming up"
// CARD's own already-3-row-capped rows — the card's cap (§1's rare-event
// reservation) is a display rule, and must never silently exclude a 4th
// simultaneous rare event from alert eligibility. See `readSkyAlertCandidates`
// below for how that list reaches this module.

import type { ConditionsSnapshot } from "@/lib/types";
import type {
  EclipseSkyEvent,
  IsoInstant,
  LaunchSkyEvent,
  MeteorSkyEvent,
  MoonSkyEvent,
  SkyEvent,
  TideSkyEvent,
} from "@/lib/skyEventsTypes";
import type { ComingUpSubject } from "@/lib/alerts/catalog";
import { isLaunchFeedFreshForAlerts } from "@/lib/sources/launchLibrary";
import { fmtDate, fmtTime } from "@/lib/format";
import { localHourParts } from "@/lib/history/archive";
import { MORNING_HOUR } from "@/lib/push/notify";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// --- Uncapped candidate list (§10, HIGH #2) ---------------------------------
//
// `snapshot.skyAlertCandidates` — the conditions build's uncapped,
// alert-relevant SkyEvent list for a beach, from the SAME buildComingUp()
// pass as the card's `skyEvents` but never trimmed to 3 rows or subject to
// the reserved-rare-row selection (lib/types.ts's own doc on the field).
// `null`/`undefined` (no snapshot, a failed buildComingUp() pass, or a
// snapshot literal that predates this field) reads as an empty list, never
// a fabricated candidate.
export function readSkyAlertCandidates(
  snapshot: Pick<ConditionsSnapshot, "skyAlertCandidates"> | null | undefined,
): readonly SkyEvent[] {
  return snapshot?.skyAlertCandidates ?? [];
}

/** §3/§10 — a validated flood-threshold crossing is only alert-eligible when
 *  its feed is fresher than this (tighter than the card's own 30-day bar). */
export const TIDE_ALERT_MAX_FEED_AGE_MS = 14 * DAY_MS;

/** A published `feedGeneratedAt` more than this far in the FUTURE relative to
 *  `nowMs` is implausible (clock skew or a corrupted publish) — rejected the
 *  same as a too-stale one, never treated as "extra fresh" (Codex review). */
export const TIDE_ALERT_MAX_FUTURE_SKEW_MS = 10 * 60_000;

/** §10 — the tide episode's first qualifying high must be 6-30h ahead of the
 *  8:00 AM run. */
const TIDE_MIN_LEAD_MS = 6 * HOUR_MS;
const TIDE_MAX_LEAD_MS = 30 * HOUR_MS;

/** §7/§10 — a launch's `net` must be 2-12h ahead of now. */
const LAUNCH_MIN_LEAD_MS = 2 * HOUR_MS;
const LAUNCH_MAX_LEAD_MS = 12 * HOUR_MS;

/** A naive `[windowStart, windowStart + 24h)` span — kept only as a fallback
 *  for a caller with no timezone on hand. `beachLocal8amWindow` below is the
 *  real thing every 8:00 AM run should use: exactly 24h on an ordinary day,
 *  but 23h/25h across a DST transition, since the window is defined by two
 *  CALENDAR-DAY-APART wall-clock instants, not a fixed duration (§10). */
export const COMING_UP_WINDOW_MS = DAY_MS;

/**
 * `[current 8:00 AM, next 8:00 AM)` in `tz`, as UTC epoch-ms instants —
 * DST-aware (HIGH #5): each boundary is computed from its OWN calendar
 * date's actual UTC offset, via `lib/history/archive.ts`'s `localHourParts`
 * (the same "treat local wall-clock numbers as UTC, diff against the real
 * instant" trick that module already uses for DST-safe hour bucketing), so
 * the gap between the two instants is exactly 24h on an ordinary day but
 * 23h (spring-forward) or 25h (fall-back) when the beach's own clocks
 * change overnight — never a naive `+ 24 * 60 * 60 * 1000`.
 *
 * `nowMs` only supplies "today's" local calendar date — the caller is
 * expected to invoke this while it's actually the beach's own 8-9 AM local
 * hour (the existing `hour === MORNING_HOUR` gate), so `windowStart` always
 * lands at or before `nowMs` (a run any time during that hour, e.g. 8:35,
 * still gets the SAME pinned 8:00:00 boundary, not a moving one).
 */
export function beachLocal8amWindow(nowMs: number, tz: string): { windowStart: number; windowEnd: number } {
  const today = localHourParts(tz, nowMs).date; // "YYYY-MM-DD", beach-local
  const [y, m, d] = today.split("-").map(Number);
  const windowStart = utcMsForLocalWallClock(tz, y, m, d, MORNING_HOUR);
  const tomorrow = new Date(Date.UTC(y, m - 1, d));
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const windowEnd = utcMsForLocalWallClock(
    tz,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    MORNING_HOUR,
  );
  return { windowStart, windowEnd };
}

/** The UTC epoch-ms instant for `hour:00:00` local wall-clock time on
 *  `y-m-d` in `tz`. Two-iteration convergence (the standard technique):
 *  guess the instant by treating the desired local numbers as UTC, read
 *  back what `tz`'s ACTUAL offset is at that guess, correct, and repeat
 *  once more — safe for any real-world zone/offset, DST transition or not,
 *  since `hour` (8 AM) never itself falls inside a transition's own
 *  discontinuity for any IANA zone this app serves. */
function utcMsForLocalWallClock(tz: string, y: number, m: number, d: number, hour: number): number {
  const desired = Date.UTC(y, m - 1, d, hour, 0, 0);
  let guess = desired;
  for (let i = 0; i < 2; i++) {
    const offsetMinutes = localHourParts(tz, guess).offsetMinutes;
    const corrected = desired - offsetMinutes * 60_000;
    if (corrected === guess) break;
    guess = corrected;
  }
  return guess;
}

/** One eligible candidate, ready for `buildComingUpSubject` — pairs the
 *  underlying `SkyEvent` with the exact §10 dedupe key for its kind. */
export type ComingUpSelection =
  | { eventType: "eclipse"; event: EclipseSkyEvent; eventKey: string }
  | { eventType: "tide"; event: TideSkyEvent; eventKey: string }
  | { eventType: "meteor"; event: MeteorSkyEvent; eventKey: string }
  | { eventType: "supermoon"; event: MoonSkyEvent; eventKey: string }
  | { eventType: "launch"; event: LaunchSkyEvent; eventKey: string };

function ms(iso: IsoInstant): number {
  return Date.parse(iso);
}

function isFreshSource(source: { validThrough: IsoInstant }, nowMs: number): boolean {
  const t = ms(source.validThrough);
  return Number.isFinite(t) && nowMs < t;
}

/** `[start, end)` overlaps `[windowStart, windowEnd)` at all. */
function overlaps(startIso: IsoInstant, endIso: IsoInstant, windowStart: number, windowEnd: number): boolean {
  const s = ms(startIso);
  const e = ms(endIso);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return s < windowEnd && e > windowStart;
}

/** `start` falls inside `[windowStart, windowEnd)`. */
function startsWithin(startIso: IsoInstant, windowStart: number, windowEnd: number): boolean {
  const s = ms(startIso);
  return Number.isFinite(s) && s >= windowStart && s < windowEnd;
}

// --- Per-type eligibility (§10) --------------------------------------------

function eclipseEligible(e: EclipseSkyEvent, nowMs: number, windowStart: number, windowEnd: number): boolean {
  if (!isFreshSource(e.source, nowMs)) return false;
  if (ms(e.visible.end) <= nowMs) return false; // already-ended events never qualify
  return overlaps(e.visible.start, e.visible.end, windowStart, windowEnd);
}

function tideEligible(e: TideSkyEvent, nowMs: number, windowStart: number): boolean {
  if (e.tier !== "validated") return false; // §3 tier 1 only — never very-high
  if (!isFreshSource(e.source, nowMs)) return false;
  const feedAgeMs = nowMs - ms(e.source.feedGeneratedAt);
  if (!Number.isFinite(feedAgeMs) || feedAgeMs > TIDE_ALERT_MAX_FEED_AGE_MS || feedAgeMs < -TIDE_ALERT_MAX_FUTURE_SKEW_MS) {
    return false;
  }
  const startMs = ms(e.episode.start);
  if (!Number.isFinite(startMs)) return false;
  if (startMs <= nowMs) return false; // already under way / past → never qualifies as "coming up"
  const aheadMs = startMs - windowStart;
  return aheadMs >= TIDE_MIN_LEAD_MS && aheadMs <= TIDE_MAX_LEAD_MS;
}

function meteorEligible(e: MeteorSkyEvent, nowMs: number, windowStart: number, windowEnd: number): boolean {
  if (ms(e.bestLocalWindow.end) <= nowMs) return false; // already-ended events never qualify
  return startsWithin(e.bestLocalWindow.start, windowStart, windowEnd);
}

function supermoonEligible(e: MoonSkyEvent, nowMs: number, windowStart: number, windowEnd: number): boolean {
  if (!e.isSupermoon) return false;
  if (!isFreshSource(e.source, nowMs)) return false;
  if (ms(e.viewingWindow.end) <= nowMs) return false; // already-ended events never qualify
  return startsWithin(e.viewingWindow.start, windowStart, windowEnd);
}

function launchEligible(e: LaunchSkyEvent, nowMs: number): boolean {
  if (e.status !== "Go") return false;
  if (e.netPrecision !== "Minute") return false;
  if (!isLaunchFeedFreshForAlerts(e.source.feedGeneratedAt, nowMs)) return false; // §8's 45-min alert gate
  const netMs = ms(e.net);
  if (!Number.isFinite(netMs)) return false;
  const aheadMs = netMs - nowMs;
  return aheadMs >= LAUNCH_MIN_LEAD_MS && aheadMs <= LAUNCH_MAX_LEAD_MS;
}

// --- Dedupe keys (§10) -------------------------------------------------------

function meteorEventKey(e: MeteorSkyEvent): string {
  const year = new Date(e.peak).getUTCFullYear();
  return `meteor:${e.showerId}:${year}`;
}

/**
 * Pick at most one eligible sky event from the UNCAPPED candidate list
 * (every alert-relevant SkyEvent the conditions build produced for this
 * beach — `readSkyAlertCandidates`, HIGH #2 — never the "Coming up" card's
 * own already-3-row-capped rows), by priority: eclipse > validated
 * flood-threshold tide crossing > major meteor peak > supermoon > launch
 * (§10). Within a type, the soonest eligible candidate wins (deterministic,
 * and the natural reading of "what's coming up"). `windowStart`/`windowEnd`
 * are the beach-local `[current 8:00 AM, next 8:00 AM)` run window —
 * `beachLocal8amWindow` computes the real (DST-aware) pair.
 */
export function selectComingUpEvent(
  events: readonly SkyEvent[] | null | undefined,
  nowMs: number,
  windowStart: number,
  windowEnd: number,
): ComingUpSelection | null {
  const list = events ?? [];

  const eclipses = list
    .filter((e): e is EclipseSkyEvent => e.eventType === "eclipse" && eclipseEligible(e, nowMs, windowStart, windowEnd))
    .sort((a, b) => ms(a.visible.start) - ms(b.visible.start));
  if (eclipses[0]) return { eventType: "eclipse", event: eclipses[0], eventKey: `eclipse:${eclipses[0].peak}` };

  const tides = list
    .filter((e): e is TideSkyEvent => e.eventType === "tide" && tideEligible(e, nowMs, windowStart))
    .sort((a, b) => ms(a.episode.start) - ms(b.episode.start));
  if (tides[0]) {
    const t = tides[0];
    return { eventType: "tide", event: t, eventKey: `tide:${t.stationId}:${t.episode.start}` };
  }

  const meteors = list
    .filter((e): e is MeteorSkyEvent => e.eventType === "meteor" && meteorEligible(e, nowMs, windowStart, windowEnd))
    .sort((a, b) => ms(a.bestLocalWindow.start) - ms(b.bestLocalWindow.start));
  if (meteors[0]) return { eventType: "meteor", event: meteors[0], eventKey: meteorEventKey(meteors[0]) };

  const supermoons = list
    .filter((e): e is MoonSkyEvent => e.eventType === "moon" && supermoonEligible(e, nowMs, windowStart, windowEnd))
    .sort((a, b) => ms(a.viewingWindow.start) - ms(b.viewingWindow.start));
  if (supermoons[0]) {
    const m = supermoons[0];
    return { eventType: "supermoon", event: m, eventKey: `supermoon:${m.fullMoonInstant}` };
  }

  const launches = list
    .filter((e): e is LaunchSkyEvent => e.eventType === "launch" && launchEligible(e, nowMs))
    .sort((a, b) => ms(a.net) - ms(b.net));
  if (launches[0]) return { eventType: "launch", event: launches[0], eventKey: `launch:${launches[0].ll2Id}` };

  return null;
}

// --- Copy formatting (push-time, beach-local — §12) -------------------------

/** "Sun Mar 8" — weekday + short date, beach-local. */
function fmtWeekdayDate(iso: IsoInstant, tz: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: tz }).format(new Date(iso));
  return `${weekday} ${fmtDate(iso, tz)}`;
}

/** "Thu Oct 15, 11:42 AM" — weekday + date, comma, time (§12's tide form). */
function fmtWeekdayDateTime(iso: IsoInstant, tz: string): string {
  return `${fmtWeekdayDate(iso, tz)}, ${fmtTime(iso, tz)}`;
}

/** "9:15 PM Wed Oct 8" — time first, then weekday + date (§12's launch form). */
function fmtTimeWeekdayDate(iso: IsoInstant, tz: string): string {
  return `${fmtTime(iso, tz)} ${fmtWeekdayDate(iso, tz)}`;
}

function timeAndPeriod(iso: IsoInstant, tz: string): { clock: string; period: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  }).formatToParts(new Date(iso));
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const period = (parts.find((p) => p.type === "dayPeriod")?.value ?? "").toUpperCase();
  return { clock: `${hour}:${minute}`, period };
}

/** "1:10-1:42 AM" (same AM/PM) or "11:50 PM-12:10 AM" (crosses it) — §12's
 *  eclipse "visible here from …" form. */
function fmtRange(startIso: IsoInstant, endIso: IsoInstant, tz: string): string {
  const start = timeAndPeriod(startIso, tz);
  const end = timeAndPeriod(endIso, tz);
  return start.period === end.period
    ? `${start.clock}-${end.clock} ${end.period}`
    : `${start.clock} ${start.period}-${end.clock} ${end.period}`;
}

/**
 * Turn a selected event into the one `ComingUpSubject` the catalog's
 * `buildAlert` needs — every date/time clause formatted beach-local, right
 * here at push time (the same place ripRisk/copy.ts's push-facing copy does
 * its own `Intl` formatting), never inside `lib/alerts/catalog.ts` itself.
 */
export function buildComingUpSubject(selection: ComingUpSelection, tz: string): ComingUpSubject {
  switch (selection.eventType) {
    case "eclipse": {
      const e = selection.event;
      const peakVisible = e.peakIsVisible;
      return {
        key: "coming-up",
        eventType: "eclipse",
        eventKey: selection.eventKey,
        kindLabel: e.kind === "total" ? "Total" : "Partial",
        whenLabel: fmtWeekdayDate(peakVisible ? e.peak : e.visible.start, tz),
        peakTimeLabel: peakVisible ? fmtTime(e.peak, tz) : undefined,
        visibleRangeLabel: peakVisible ? undefined : fmtRange(e.visible.start, e.visible.end, tz),
        ratingLabel: e.rating?.label,
      };
    }
    case "tide": {
      const e = selection.event;
      return {
        key: "coming-up",
        eventType: "tide",
        eventKey: selection.eventKey,
        whenLabel: fmtWeekdayDateTime(e.episode.start, tz),
      };
    }
    case "meteor": {
      const e = selection.event;
      return {
        key: "coming-up",
        eventType: "meteor",
        eventKey: selection.eventKey,
        showerName: e.showerName,
        whenLabel: fmtWeekdayDate(e.peak, tz),
        ratingLabel: e.rating?.label,
      };
    }
    case "supermoon": {
      const e = selection.event;
      return {
        key: "coming-up",
        eventType: "supermoon",
        eventKey: selection.eventKey,
        whenLabel: fmtWeekdayDate(e.fullMoonInstant, tz),
        overWaterLine: e.overWater?.line,
        isClosestOfYear: e.supermoonRank === 1,
      };
    }
    case "launch": {
      const e = selection.event;
      return {
        key: "coming-up",
        eventType: "launch",
        eventKey: selection.eventKey,
        name: e.name,
        whenLabel: fmtTimeWeekdayDate(e.net, tz),
      };
    }
  }
}
