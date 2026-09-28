// ---------------------------------------------------------------------------
// Moon sky events — full moon, supermoon, lunar eclipse, moonrise "over the
// water" — for the "Coming up" card (docs/SKY_EVENTS_PLAN.md §4). Wraps
// `astronomy-engine` (MIT, cosinekitty/astronomy) so nothing here re-derives
// orbital mechanics by hand. Everything is computed locally and
// deterministically: no network fetch, no `Date.now()`/`new Date()` default —
// every entry point takes `now` as an explicit argument (§9's SSR-safety
// rule, same convention as `lib/sources/sun.ts`'s `computeSunTimes`).
//
// SERVER-ONLY. `astronomy-engine` is ~105 KB minified / ~42.5 KB gzip and has
// no reason to ever reach a client bundle (§9's acceptance criteria: before/
// after OpenNext bundle comparison, a grep/bundle-analysis pass, all owned by
// Phase 4/INTEGRATION — not this file). This repo has no `server-only`
// package dependency today (confirmed: absent from package.json and
// node_modules, and no other file imports one) — Crew B's task note said to
// add that import "if the repo uses it," and it doesn't, so adding the
// package here would be a scope violation (this file is only allowed to
// touch package.json/package-lock.json for the one `astronomy-engine` add).
// Instead: a loud runtime guard below, matching the repo's existing
// convention for a server-only module (lib/db/store.ts relies on `node:crypto`
// simply not existing in a browser bundle; this module has no such natural
// tripwire since astronomy-engine is pure JS, so the guard is explicit here).
// Every caller must import this only from server code (a route handler, a
// script, or a non-"use client" component) — never from a "use client" file.
if (typeof window !== "undefined") {
  throw new Error(
    "lib/sources/moonEvents.ts is server-only (SKY_EVENTS_PLAN.md §9) — it must never be imported by a client component.",
  );
}

import {
  Body,
  ApsisKind,
  EclipseKind,
  KM_PER_AU,
  MakeTime,
  NextLunarApsis,
  NextLunarEclipse,
  NextMoonQuarter,
  SearchAltitude,
  SearchLunarApsis,
  SearchLunarEclipse,
  SearchMoonQuarter,
  SearchRiseSet,
  Equator,
  GeoVector,
  Horizon,
  Observer,
  type AstroTime,
  type Apsis,
} from "astronomy-engine";
import { computeSunTimes } from "@/lib/sources/sun";
import type {
  EclipseSkyEvent,
  IsoInstant,
  IsoInterval,
  MoonSkyEvent,
  WhereToLook,
  WrappedMoonEvents,
} from "@/lib/skyEventsTypes";

const SOURCE = "Computed (astronomy-engine)";
const ATTRIBUTION = "Computed (astronomy-engine lunar ephemeris)";

/** The Moon must be at least this high for a moon/eclipse event to count as
 *  actually visible from the beach (SKY_EVENTS_PLAN.md §4). */
const MIN_ALTITUDE_DEG = 5;

/** A supermoon's Nolle closeness ratio must clear this bar (§4). */
const SUPERMOON_CLOSENESS_MIN = 0.9;

/** An eclipse's visible interval (contact ∩ ≥5° altitude) must be at least
 *  this long to be shown at all (§4's round-3 fix). */
const MIN_ECLIPSE_VISIBLE_MS = 15 * 60_000;

/** How far back of `now` to start the full-moon/eclipse search. Not about
 *  which events "count" (that's `now < validThrough`, checked after building
 *  each event) — just wide enough that an event whose defining instant (the
 *  full-moon instant, or an eclipse's peak) already passed a little while ago
 *  is still found, so its viewing/visible window can be checked for "still
 *  under way." 2 days comfortably covers both: a full moon's viewing window
 *  never runs past the following dawn, and a lunar eclipse's longest possible
 *  contact span (first partial contact to last) is a few hours. */
const SEARCH_LOOKBACK_DAYS = 2;

// --- Input shape -------------------------------------------------------------

/**
 * The minimal, structurally-typed location this module needs — deliberately
 * NOT `lib/types.ts`'s full `Location`, so this stays a small, dependency-free
 * unit (same ethos as `lib/sunQuality.ts`). `coastNormalDeg` is the reviewed
 * shore-normal bearing (curated beaches only, §4) — the caller must source it
 * server-side, since it isn't on the client-facing location shape (§2, §4).
 */
export interface MoonEventsLocation {
  lat: number;
  lon: number;
  /** IANA timezone, e.g. "America/New_York" — used only to find the correct
   *  local dusk/dawn bracketing the full-moon night (§4). */
  timezone: string;
  /** Reviewed shore-normal bearing, degrees (§4). Omit when this beach has no
   *  manually reviewed shore normal — the moon/supermoon event still shows,
   *  just without the "over the water" line. */
  coastNormalDeg?: number;
}

// --- Pure geometry helpers -----------------------------------------------------

function mod360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Whether a moonrise azimuth counts as "over the water" for a beach with a
 * reviewed shore normal: the circular angular difference (bearings wrap at
 * 360°) is ≤30° (SKY_EVENTS_PLAN.md §4). A naive `Math.abs(a - b)` would
 * wrongly reject a pair like 350° vs 10° (really 20° apart) — this uses the
 * shorter arc both ways around the circle instead.
 */
export function isOverWater(moonriseAzimuthDeg: number, coastNormalDeg: number): boolean {
  const diff = Math.abs(mod360(moonriseAzimuthDeg) - mod360(coastNormalDeg));
  const circularDiff = Math.min(diff, 360 - diff);
  return circularDiff <= 30;
}

// --- astronomy-engine plumbing --------------------------------------------------

function toObserver(loc: MoonEventsLocation): Observer {
  return new Observer(loc.lat, loc.lon, 0);
}

/** Topocentric azimuth/altitude of the Moon at `t`, from `observer`. */
function moonHorizon(observer: Observer, t: AstroTime) {
  const eq = Equator(Body.Moon, t, observer, true, true);
  return Horizon(t, observer, eq.ra, eq.dec, "normal");
}

/** Geocentric Earth-Moon center-to-center distance in km at `t` — the same
 *  quantity `Apsis.dist_km` reports, so the Nolle ratio compares like with
 *  like (never a topocentric, beach-specific distance, which would bias the
 *  ratio by up to Earth's radius — small in absolute terms but not
 *  negligible against the ~1-10% closeness bands this ratio cares about). */
function geocentricMoonDistanceKm(t: AstroTime): number {
  return GeoVector(Body.Moon, t, true).Length() * KM_PER_AU;
}

/**
 * The perigee and apogee bracketing the SAME anomalistic (perigee-to-perigee,
 * ~27.55-day) cycle as `t` — the consecutive apsis pair immediately before
 * and after `t` in time, which (since `SearchLunarApsis`/`NextLunarApsis`
 * always alternate kind) is guaranteed to be one perigee and one apogee, not
 * "the nearest apsis of each kind independently," which can straddle two
 * different cycles near a cycle boundary (SKY_EVENTS_PLAN.md §4).
 */
function bracketingApsides(t: AstroTime): { perigee: Apsis; apogee: Apsis } {
  // Look back comfortably more than one full anomalistic month so the walk
  // forward is guaranteed to pass an apsis before `t`.
  let apsis = SearchLunarApsis(t.AddDays(-40));
  let prev: Apsis | null = null;
  let guard = 0;
  while (apsis.time.tt < t.tt) {
    prev = apsis;
    apsis = NextLunarApsis(apsis);
    if (++guard > 8) {
      throw new Error("bracketingApsides: apsis walk did not converge — unexpected orbital search failure");
    }
  }
  if (!prev) {
    throw new Error("bracketingApsides: no apsis found before the target time");
  }
  return prev.kind === ApsisKind.Pericenter ? { perigee: prev, apogee: apsis } : { perigee: apsis, apogee: prev };
}

/** Nolle closeness ratio: 1.0 = exactly at perigee, 0.0 = exactly at apogee. */
function nolleCloseness(fullMoonDistanceKm: number, perigeeKm: number, apogeeKm: number): number {
  return (apogeeKm - fullMoonDistanceKm) / (apogeeKm - perigeeKm);
}

/**
 * The sub-interval of `[start, end]` (an `AstroTime` pair) where the Moon's
 * altitude at `observer` stays ≥ `minAltDeg`, or `null` when it never clears
 * that altitude within the window at all. Handles the Moon rising or setting
 * partway through the window (the eclipse "visible only before/after peak"
 * cases, §4) by searching for the actual crossing instant rather than just
 * checking the two endpoints. Assumes at most one rise and one set within
 * `[start, end]` — true for every window this module hands it (a full-moon
 * viewing window or an eclipse's few-hour contact interval), since the Moon
 * doesn't rise and set twice within a few hours.
 */
function moonVisibleWithin(
  observer: Observer,
  start: AstroTime,
  end: AstroTime,
  minAltDeg: number,
): { start: AstroTime; end: AstroTime } | null {
  if (end.ut <= start.ut) return null;
  const spanDays = end.ut - start.ut;
  const altStart = moonHorizon(observer, start).altitude;
  const altEnd = moonHorizon(observer, end).altitude;

  let visStart = start;
  if (altStart < minAltDeg) {
    const rise = SearchAltitude(Body.Moon, observer, +1, start, spanDays, minAltDeg);
    if (!rise || rise.ut >= end.ut) return null; // never reaches minAltDeg inside the window
    visStart = rise;
  }

  let visEnd = end;
  if (altEnd < minAltDeg) {
    const remainingDays = end.ut - visStart.ut;
    if (remainingDays <= 0) return null;
    const set = SearchAltitude(Body.Moon, observer, -1, visStart, remainingDays, minAltDeg);
    if (!set || set.ut <= visStart.ut) return null;
    visEnd = set.ut < end.ut ? set : end;
  }

  if (visEnd.ut <= visStart.ut) return null;
  return { start: visStart, end: visEnd };
}

function iso(t: AstroTime): IsoInstant {
  return t.date.toISOString();
}

/** The calendar Y/M/D `now` falls on, observed in `tz` — same technique
 *  `lib/sources/sun.ts`'s private `localYMD` uses; duplicated here (not
 *  imported — it isn't exported) to keep this module's surface small. */
function localYMD(tz: string, now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

// --- Full moon / supermoon -----------------------------------------------------

interface FullMoonCandidate {
  time: AstroTime;
  distanceKm: number;
  closeness: number;
  isSupermoon: boolean;
}

function computeFullMoonCandidate(time: AstroTime): FullMoonCandidate {
  const distanceKm = geocentricMoonDistanceKm(time);
  const { perigee, apogee } = bracketingApsides(time);
  const closeness = nolleCloseness(distanceKm, perigee.dist_km, apogee.dist_km);
  return { time, distanceKm, closeness, isSupermoon: closeness >= SUPERMOON_CLOSENESS_MIN };
}

/** Every full moon (`SearchMoonQuarter` quarter 2) with a time in
 *  `[startTime, endTime]`, inclusive. */
function fullMoonsBetween(startTime: AstroTime, endTime: AstroTime): AstroTime[] {
  const out: AstroTime[] = [];
  let mq = SearchMoonQuarter(startTime);
  let guard = 0;
  while (mq.time.ut <= endTime.ut) {
    if (mq.quarter === 2 && mq.time.ut >= startTime.ut) out.push(mq.time);
    mq = NextMoonQuarter(mq);
    if (++guard > 60) break; // safety valve — ~5 years of quarters, never legitimately reached
  }
  return out;
}

// Location-independent (a full moon's geocentric distance doesn't depend on
// the observer), so cached once per UTC calendar year rather than per beach —
// every one of the 39 beaches asking about the same year reuses this.
const supermoonYearCache = new Map<number, FullMoonCandidate[]>();

/** Every supermoon (closeness ≥ 0.90) full moon in UTC calendar year
 *  `utcYear`, sorted closest-first — "closest full moon of the year" (§4)
 *  ranks off this list. UTC year, not beach-local: this is a global
 *  astronomical property, and a beach-local year would make the same full
 *  moon rank differently depending which beach asked (undesirable — the
 *  card's "closest full moon of the year" line should agree everywhere). */
function supermoonsInYear(utcYear: number): FullMoonCandidate[] {
  const cached = supermoonYearCache.get(utcYear);
  if (cached) return cached;
  // Start the search a month early and stop a month late so a full moon
  // right at the year boundary is never missed by an off-by-one window edge.
  const start = MakeTime(new Date(Date.UTC(utcYear - 1, 11, 1)));
  const end = MakeTime(new Date(Date.UTC(utcYear + 1, 0, 31)));
  const candidates = fullMoonsBetween(start, end)
    .filter((t) => t.date.getUTCFullYear() === utcYear)
    .map(computeFullMoonCandidate)
    .filter((c) => c.isSupermoon)
    .sort((a, b) => a.distanceKm - b.distanceKm);
  supermoonYearCache.set(utcYear, candidates);
  return candidates;
}

/** 1 when `candidate` is the closest supermoon of its own UTC year, else
 *  `undefined` — `MoonSkyEvent.supermoonRank` is never set to anything but 1
 *  (§4, §12: "closest full moon of the year" is binary, not a countdown). */
function supermoonRankOf(candidate: FullMoonCandidate): number | undefined {
  if (!candidate.isSupermoon) return undefined;
  const year = candidate.time.date.getUTCFullYear();
  const ranked = supermoonsInYear(year);
  return ranked[0] && ranked[0].time.ut === candidate.time.ut ? 1 : undefined;
}

/**
 * The full-moon/supermoon viewing window for one beach (§4): the first
 * nighttime interval near the full-moon instant where the Moon's altitude is
 * ≥5°, bounded by moonrise-or-dusk (whichever later) through moonset-or-dawn
 * (whichever earlier). Computed for every beach, independent of shore-normal
 * review. Returns `null` on the (practically unreachable for these 39
 * beaches, all well outside polar latitudes) edge case where no such window
 * exists.
 */
function fullMoonViewingWindow(
  observer: Observer,
  loc: MoonEventsLocation,
  fullMoonTime: AstroTime,
): { window: { start: AstroTime; end: AstroTime }; moonrise: AstroTime; moonriseAzimuthDeg: number } | null {
  // The Moon near a full moon rises near local sunset and sets near local
  // sunrise the following morning. Find the bracketing rise/set pair by
  // searching OUTWARD from the full-moon instant — first the next moonset
  // after it, then the moonrise immediately before that moonset — rather
  // than a fixed lookback window: a naive "search from fullMoon − 1.5 days"
  // can land on the WRONG (previous night's) moonrise, since moonrise-to-
  // moonrise cadence (~24h50m) is itself longer than 1.5 days' slack. This
  // pair is provably the correct bracket: moonset/moonrise events strictly
  // alternate, so "next set after fullMoon" and "the rise immediately before
  // that set" have no other rise/set event between them, and since the full
  // moon is a beach-independent global instant, at most one of the two ends
  // needs to have actually happened yet — either the Moon is already up at
  // the full-moon instant (this bracket contains it), or it rises shortly
  // after (this bracket starts just after it) — both are "near the full-moon
  // instant" per the spec's own wording.
  const moonset = SearchRiseSet(Body.Moon, observer, -1, fullMoonTime, 1.5);
  if (!moonset) return null;
  const moonrise = SearchRiseSet(Body.Moon, observer, +1, moonset, -1.5);
  if (!moonrise) return null;

  const riseYmd = localYMD(loc.timezone, moonrise.date);
  const dusk = computeSunTimes(loc.lat, loc.lon, riseYmd.y, riseYmd.m, riseYmd.d).dusk;
  const nextDay = new Date(Date.UTC(riseYmd.y, riseYmd.m - 1, riseYmd.d + 1));
  const dawn = computeSunTimes(loc.lat, loc.lon, nextDay.getUTCFullYear(), nextDay.getUTCMonth() + 1, nextDay.getUTCDate())
    .daybreak;

  const boundStart = dusk && dusk.getTime() > moonrise.date.getTime() ? MakeTime(dusk) : moonrise;
  const boundEnd = dawn && dawn.getTime() < moonset.date.getTime() ? MakeTime(dawn) : moonset;

  const window = moonVisibleWithin(observer, boundStart, boundEnd, MIN_ALTITUDE_DEG);
  if (!window) return null;

  const riseHorizon = moonHorizon(observer, moonrise);
  return { window, moonrise, moonriseAzimuthDeg: riseHorizon.azimuth };
}

function buildMoonSkyEvent(
  observer: Observer,
  loc: MoonEventsLocation,
  candidate: FullMoonCandidate,
  fetchedAtIso: IsoInstant,
): MoonSkyEvent | null {
  const viewing = fullMoonViewingWindow(observer, loc, candidate.time);
  if (!viewing) return null; // no qualifying nighttime window (edge case, see fullMoonViewingWindow)

  const viewingWindow: IsoInterval = { start: iso(viewing.window.start), end: iso(viewing.window.end) };
  const rank = supermoonRankOf(candidate);

  let overWater: WhereToLook | undefined;
  if (loc.coastNormalDeg != null && isOverWater(viewing.moonriseAzimuthDeg, loc.coastNormalDeg)) {
    overWater = { bearingDeg: viewing.moonriseAzimuthDeg, line: "over the water" };
  }

  return {
    eventType: "moon",
    fullMoonInstant: iso(candidate.time),
    closeness: Math.round(candidate.closeness * 1000) / 1000,
    isSupermoon: candidate.isSupermoon,
    ...(rank ? { supermoonRank: rank } : {}),
    viewingWindow,
    moonriseLocal: iso(viewing.moonrise),
    ...(overWater ? { overWater } : {}),
    // Rating is Phase 2's job (lib/skyVisibilityQuality.ts, not landed yet
    // when this adapter was built) — always null here; the aggregator fills
    // it in from viewingWindow + forecast data (SKY_EVENTS_PLAN.md §13).
    rating: null,
    source: { feedGeneratedAt: fetchedAtIso, validThrough: viewingWindow.end },
  };
}

// --- Lunar eclipse ---------------------------------------------------------------

function buildEclipseSkyEvent(
  observer: Observer,
  ecl: { kind: EclipseKind; peak: AstroTime; sd_partial: number; sd_total: number },
  fetchedAtIso: IsoInstant,
): EclipseSkyEvent | null {
  if (ecl.kind !== EclipseKind.Partial && ecl.kind !== EclipseKind.Total) return null; // penumbral never surfaced (§4)

  const semiDurationMin = ecl.kind === EclipseKind.Total ? ecl.sd_total : ecl.sd_partial;
  const contactStart = ecl.peak.AddDays(-semiDurationMin / 1440);
  const contactEnd = ecl.peak.AddDays(semiDurationMin / 1440);

  const visible = moonVisibleWithin(observer, contactStart, contactEnd, MIN_ALTITUDE_DEG);
  if (!visible) return null;
  const visibleMs = visible.end.date.getTime() - visible.start.date.getTime();
  if (visibleMs < MIN_ECLIPSE_VISIBLE_MS) return null; // §4's round-3 ≥15-min floor

  const peakIsVisible = ecl.peak.ut >= visible.start.ut && ecl.peak.ut <= visible.end.ut;
  const visibleInterval: IsoInterval = { start: iso(visible.start), end: iso(visible.end) };

  return {
    eventType: "eclipse",
    kind: ecl.kind === EclipseKind.Total ? "total" : "partial",
    peak: iso(ecl.peak),
    peakIsVisible,
    visible: visibleInterval,
    rating: null, // Phase 2's job, see buildMoonSkyEvent's note
    source: { feedGeneratedAt: fetchedAtIso, validThrough: visibleInterval.end },
  };
}

// --- Cache (§9: deterministic by date + rounded lat/lon) ---------------------

const RESULT_CACHE_MAX = 200;
const resultCache = new Map<string, WrappedMoonEvents>();

function cacheKey(loc: MoonEventsLocation, now: Date, windowDays: number): string {
  // Same inputs -> same outputs (pure astronomy, no live data), so the cache
  // key only needs to capture the inputs that can change the result: the UTC
  // calendar day of `now` (results shift day to day as the window slides),
  // the window length, rounded lat/lon (2 decimals ≈ ~1.1km — plenty precise
  // for which full moon/eclipse phase applies), timezone (changes dusk/dawn),
  // and coastNormalDeg (changes the overWater line).
  const day = now.toISOString().slice(0, 10);
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
  const coast = loc.coastNormalDeg != null ? loc.coastNormalDeg.toFixed(1) : "none";
  return `${day}|${windowDays}|${lat}|${lon}|${loc.timezone}|${coast}`;
}

function setCache(key: string, value: WrappedMoonEvents): void {
  if (resultCache.size >= RESULT_CACHE_MAX) {
    const oldest = resultCache.keys().next().value;
    if (oldest !== undefined) resultCache.delete(oldest);
  }
  resultCache.set(key, value);
}

// --- Public entry point -----------------------------------------------------------

/**
 * Full-moon/supermoon and lunar-eclipse sky events for one beach, in
 * `[now, now + windowDays]`. Pure and deterministic: `now` is the only clock
 * input, injected by the caller (never `Date.now()`/`new Date()` inside this
 * module, per §9's SSR-safety rule). Results are cached by (date, rounded
 * lat/lon, timezone, coastNormalDeg) — see `cacheKey`.
 */
export function fetchMoonEvents(loc: MoonEventsLocation, now: Date, windowDays = 14): WrappedMoonEvents {
  const fetchedAt = now.toISOString();
  const key = cacheKey(loc, now, windowDays);
  const cached = resultCache.get(key);
  if (cached) return cached;

  try {
    const observer = toObserver(loc);
    const startTime = MakeTime(now).AddDays(-SEARCH_LOOKBACK_DAYS);
    const endTime = MakeTime(now).AddDays(windowDays);

    const events: (EclipseSkyEvent | MoonSkyEvent)[] = [];
    const nowMs = now.getTime();

    // A full moon whose exact instant already passed a little while ago can
    // still have an "ongoing" viewing window (it can stretch past midnight
    // into the following dawn) — so events are only dropped once their OWN
    // window has ended (`validThrough`), never just because the instant
    // itself is in the past. `fullMoonsBetween` already bounds candidates to
    // [now - SEARCH_LOOKBACK_DAYS, now + windowDays], so this can't reach
    // back to a full moon from a prior lunar month.
    for (const fmTime of fullMoonsBetween(startTime, endTime)) {
      const candidate = computeFullMoonCandidate(fmTime);
      const event = buildMoonSkyEvent(observer, loc, candidate, fetchedAt);
      if (event && Date.parse(event.source.validThrough) >= nowMs) events.push(event);
    }

    // Same "still under way" reasoning for eclipses: search starts a little
    // before `now` so an eclipse whose peak already passed but whose visible
    // window might still be running is found, then dropped only if its own
    // visible window has actually ended.
    let ecl = SearchLunarEclipse(startTime);
    let guard = 0;
    while (ecl.peak.ut <= endTime.ut) {
      const event = buildEclipseSkyEvent(observer, ecl, fetchedAt);
      if (event && Date.parse(event.source.validThrough) >= nowMs) events.push(event);
      ecl = NextLunarEclipse(ecl.peak);
      if (++guard > 12) break; // safety valve — eclipses run ~2-5/year, never legitimately reached in 14 days
    }

    events.sort((a, b) => {
      const aTime = a.eventType === "eclipse" ? a.peak : a.fullMoonInstant;
      const bTime = b.eventType === "eclipse" ? b.peak : b.fullMoonInstant;
      return Date.parse(aTime) - Date.parse(bTime);
    });

    const result: WrappedMoonEvents = {
      source: SOURCE,
      status: "ok",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: events,
    };
    setCache(key, result);
    return result;
  } catch (e) {
    return {
      source: SOURCE,
      status: "error",
      fetchedAt,
      attribution: ATTRIBUTION,
      data: null,
      note: String(e),
    };
  }
}

// Exposed for tests only (not part of the plan's required public surface, but
// small, pure, and otherwise unreachable from outside this module).
export const __test = {
  bracketingApsides,
  nolleCloseness,
  moonVisibleWithin,
  geocentricMoonDistanceKm,
  supermoonsInYear,
};
