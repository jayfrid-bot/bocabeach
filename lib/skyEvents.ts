// ---------------------------------------------------------------------------
// "Coming up" sky-events card — pure aggregator (Phase 2B, Crew F). Merges
// the 4 wrapped source arrays — tide, moon+eclipse, meteor, launch — each
// already computed upstream by Phase 1's adapters, into one ordered,
// episode-grouped, ≤3-row SkyEventsCardData. Rates every rateable event via
// Crew E's skyVisibilityQuality (lib/skyVisibilityQuality.ts) over the
// event's OWN relevant window, never a fixed clock reading.
// See docs/SKY_EVENTS_PLAN.md §1, §5, §9.
//
// PURE: no network, no Date.now()/new Date() — `nowMs` is an explicit,
// caller-supplied instant (§9's SSR/hydration-safety rule: every displayed
// time and every selection decision is pinned to the snapshot's own
// generatedAt). Every other input is data an upstream crew already computed.
// Deterministic: same inputs, same output.
//
// This module does NOT format anything into a beach's local time — that
// happens only at the display edge, in components/SkyEventsCard.tsx (§9).
// The one exception is `tz`, used ONLY to decide whether an eclipse and a
// full moon fall on the same local night, for the "Total eclipse during the
// full moon" merge (§1) — every other decision here works in UTC.
//
// SERVER-ONLY (Codex round-2 review, HIGH #6): the real moonlight-penalty
// signal below (§5 — "an Illumination × Horizon check together") calls
// `astronomy-engine` directly, same as lib/sources/moonEvents.ts. Every
// caller must import this only from server code — never from a "use client"
// file. components/SkyEventsCard.tsx (the client card) only ever imports
// TYPES from this module's sibling lib/skyEventsTypes.ts, never runtime code
// from here, so astronomy-engine can't reach a client chunk through it.
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  throw new Error(
    "lib/skyEvents.ts is server-only (SKY_EVENTS_PLAN.md §9) — it must never be imported by a client component.",
  );
}

import { Body, Equator, Horizon, Illumination, MakeTime, Observer } from "astronomy-engine";
import type {
  EclipseSkyEvent,
  IsoInstant,
  IsoInterval,
  LaunchSkyEvent,
  MeteorSkyEvent,
  MoonSkyEvent,
  SkyEvent,
  SkyEventsCardData,
  SkyEventsCardRow,
  SkyRating,
  WrappedLaunchEvents,
  WrappedMeteorEvents,
  WrappedMoonEvents,
  WrappedTideEvents,
} from "@/lib/skyEventsTypes";
import { skyVisibilityQuality, type MoonDuringWindow, type SkyHourlyPoint } from "@/lib/skyVisibilityQuality";

/** Exactly 3 rows max, always (§1). */
const MAX_ROWS = 3;

export interface BuildComingUpInput {
  tide: WrappedTideEvents;
  moon: WrappedMoonEvents;
  meteor: WrappedMeteorEvents;
  launch: WrappedLaunchEvents;
  /** Hourly forecast rows every rateable event is sampled against — whatever
   *  the caller has (e.g. lib/sources/hourlyForecast.ts's HourlyMetrics[])
   *  passes straight through; only the rows structurally shaped like
   *  SkyHourlyPoint are read, same structural-typing convention
   *  lib/skyVisibilityQuality.ts documents for its own `hourly` param. */
  hourly: readonly SkyHourlyPoint[];
  /** The conditions snapshot's pinned instant. Every freshness check,
   *  upcoming/already-past filter, and row-selection decision is made
   *  against this — never Date.now()/new Date() (§9). */
  nowMs: number;
  /** Beach IANA timezone, e.g. "America/New_York" or "Pacific/Honolulu" —
   *  used only for the eclipse/full-moon "same local night" merge test
   *  above. Display formatting is the card component's job, not this
   *  module's (§9). */
  tz: string;
  /** Beach coordinates — the real Moon-altitude/illumination sweep (§5's
   *  moonlight penalty for a meteor shower or launch) needs the actual
   *  observer location, not just its timezone. */
  lat: number;
  lon: number;
}

export interface ComingUpResult {
  /** The capped, ordered "Coming up" card payload — null when there's
   *  nothing genuine to show (§1 — the card is hidden entirely, never an
   *  empty/placeholder card). This is the ONLY field the public API/client
   *  dashboard may ever see. */
  card: SkyEventsCardData | null;
  /** EVERY fresh, still-upcoming, rated, merged event from this same pass —
   *  never capped to 3 rows and never subject to the reserved-rare-row
   *  trim (§1). Codex round-2 review, HIGH #2: alert selection must not read
   *  the card's display subset — a routine event bumped off the visible
   *  card by the 3-row cap can still be alert-eligible on its own terms.
   *  Server-side only: strip this before a snapshot reaches a public API
   *  response or client component props (see lib/conditions.ts's
   *  `stripInternalSnapshotFields`). */
  alertCandidates: readonly SkyEvent[];
}

/**
 * Build the "Coming up" card's data for one beach — both the capped display
 * card and the full uncapped candidate pool alert selection reads instead.
 */
export function buildComingUp(input: BuildComingUpInput): ComingUpResult {
  const { tide, moon, meteor, launch, hourly, nowMs, tz, lat, lon } = input;

  const candidateRows: SkyEventsCardRow[] = [
    ...tideRows(tide, nowMs),
    ...moonAndEclipseRows(moon, nowMs, hourly, tz),
    ...meteorRows(meteor, nowMs, hourly, lat, lon),
    ...launchRows(launch, nowMs, hourly, lat, lon),
  ];

  if (candidateRows.length === 0) return { card: null, alertCandidates: [] };

  candidateRows.sort(bySortInstant);
  const alertCandidates = candidateRows.flatMap((r) => r.events);

  const rows = selectRows(candidateRows);
  const card: SkyEventsCardData | null = rows.length === 0 ? null : { rows, generatedAt: new Date(nowMs).toISOString() };

  return { card, alertCandidates };
}

// --- per-source row builders -------------------------------------------------

/** Tide episodes are already grouped by the adapter (Crew D's deterministic
 *  merge, §3 — "the feed never ships raw unmerged hilo rows to the app"), so
 *  each qualifying `TideSkyEvent` is exactly one row candidate here; this
 *  aggregator's job for tide is freshness/upcoming filtering, not re-merging
 *  raw highs. `rating` stays `null` — tides are never sky-rated (§5). */
function tideRows(wrapped: WrappedTideEvents, nowMs: number): SkyEventsCardRow[] {
  if (wrapped.status === "error" || !wrapped.data) return [];
  const rows: SkyEventsCardRow[] = [];
  for (const event of wrapped.data) {
    if (!isFresh(event.source, nowMs)) continue; // §3's validThrough
    if (Date.parse(event.episode.end) <= nowMs) continue; // episode fully over
    rows.push({ events: [event], sortInstant: event.episode.start });
  }
  return rows;
}

/** Pairs each full-moon/supermoon event with a same-night eclipse into one
 *  merged row ("Total eclipse during the full moon", §1); an unpaired moon
 *  or eclipse still gets its own row. A lunar eclipse only ever occurs at a
 *  full moon astronomically, so a pairing should normally exist whenever
 *  both are present in the same fetch — but this never assumes that; an
 *  eclipse with no matching moon event in `wrapped.data` still shows alone. */
function moonAndEclipseRows(
  wrapped: WrappedMoonEvents,
  nowMs: number,
  hourly: readonly SkyHourlyPoint[],
  tz: string,
): SkyEventsCardRow[] {
  if (wrapped.status === "error" || !wrapped.data) return [];

  const eclipses: EclipseSkyEvent[] = [];
  const moons: MoonSkyEvent[] = [];
  for (const e of wrapped.data) {
    if (!isFresh(e.source, nowMs)) continue;
    if (e.eventType === "eclipse") {
      if (Date.parse(e.visible.end) > nowMs) eclipses.push(e);
    } else {
      if (Date.parse(e.viewingWindow.end) > nowMs) moons.push(e);
    }
  }

  const usedEclipse = new Set<EclipseSkyEvent>();
  const rows: SkyEventsCardRow[] = [];

  for (const m of moons) {
    const paired = eclipses.find(
      (ec) => !usedEclipse.has(ec) && sameLocalNight(ec.peak, m.fullMoonInstant, tz),
    );
    // Never pass a `moon` signal here — rating "the Moon washes out the
    // Moon" is nonsensical; the moonlight penalty only makes sense for a
    // DIFFERENT event type (meteor, launch — see below).
    const ratedMoon = withMoonRating(m, hourly);
    if (paired) {
      usedEclipse.add(paired);
      const ratedEclipse = withEclipseRating(paired, hourly);
      const start = earlier(ratedEclipse.visible.start, ratedMoon.viewingWindow.start);
      rows.push({ events: [ratedEclipse, ratedMoon], sortInstant: start });
    } else {
      rows.push({ events: [ratedMoon], sortInstant: ratedMoon.viewingWindow.start });
    }
  }

  for (const ec of eclipses) {
    if (usedEclipse.has(ec)) continue;
    const rated = withEclipseRating(ec, hourly);
    rows.push({ events: [rated], sortInstant: rated.visible.start });
  }

  return rows;
}

/** No live feed (static yearly calendar, §6) — no `source`/`validThrough` to
 *  check, only whether the shower's best local window has already passed. */
function meteorRows(
  wrapped: WrappedMeteorEvents,
  nowMs: number,
  hourly: readonly SkyHourlyPoint[],
  lat: number,
  lon: number,
): SkyEventsCardRow[] {
  if (wrapped.status === "error" || !wrapped.data) return [];
  const rows: SkyEventsCardRow[] = [];
  for (const m of wrapped.data) {
    if (Date.parse(m.bestLocalWindow.end) <= nowMs) continue;
    const rated = withMeteorRating(m, hourly, lat, lon);
    rows.push({ events: [rated], sortInstant: rated.bestLocalWindow.start });
  }
  return rows;
}

function launchRows(
  wrapped: WrappedLaunchEvents,
  nowMs: number,
  hourly: readonly SkyHourlyPoint[],
  lat: number,
  lon: number,
): SkyEventsCardRow[] {
  if (wrapped.status === "error" || !wrapped.data) return [];
  const rows: SkyEventsCardRow[] = [];
  for (const l of wrapped.data) {
    if (!isFresh(l.source, nowMs)) continue; // §8's 45-min/6h staleness gates
    if (Date.parse(l.windowEnd) <= nowMs) continue;
    // Defense in depth: §7 has the adapter reject Cancelled/Success/Failure
    // at ingest, but a card built from a feed that outlived a status change
    // between fetch and render must not show an ended launch either.
    if (l.status === "Cancelled" || l.status === "Success" || l.status === "Failure") continue;
    const rated = withLaunchRating(l, hourly, lat, lon);
    rows.push({ events: [rated], sortInstant: rated.net });
  }
  return rows;
}

// --- rating (§5) --------------------------------------------------------------

function rateWindow(window: IsoInterval, hourly: readonly SkyHourlyPoint[], moon?: MoonDuringWindow): SkyRating | null {
  return skyVisibilityQuality({ window, hourly, moon });
}

function withEclipseRating(e: EclipseSkyEvent, hourly: readonly SkyHourlyPoint[]): EclipseSkyEvent {
  return { ...e, rating: rateWindow(e.visible, hourly) };
}

function withMoonRating(e: MoonSkyEvent, hourly: readonly SkyHourlyPoint[]): MoonSkyEvent {
  return { ...e, rating: rateWindow(e.viewingWindow, hourly) };
}

function withMeteorRating(e: MeteorSkyEvent, hourly: readonly SkyHourlyPoint[], lat: number, lon: number): MeteorSkyEvent {
  return { ...e, rating: rateWindow(e.bestLocalWindow, hourly, moonDuringWindow(lat, lon, e.bestLocalWindow)) };
}

function withLaunchRating(e: LaunchSkyEvent, hourly: readonly SkyHourlyPoint[], lat: number, lon: number): LaunchSkyEvent {
  const window: IsoInterval = { start: e.windowStart, end: e.windowEnd };
  return { ...e, rating: rateWindow(window, hourly, moonDuringWindow(lat, lon, window)) };
}

// --- real Moon altitude/illumination (§5, Codex round-2 review HIGH #6) ------
//
// Replaces the earlier "overlaps a full-moon card event -> assume 95% lit"
// shortcut with an actual astronomy-engine sweep, same library/approach
// lib/sources/moonEvents.ts already uses for the moon/eclipse events
// themselves. Every hour required to cover `window` must have a usable
// forecast row for skyVisibilityQuality to rate it at all (that module's own
// honest-null rule), so a window here is always short — a launch's own
// window or a meteor shower's best local window, at most a few hours — never
// the long multi-day spans lib/sources/moonEvents.ts's rise/set search
// handles. A fixed-step sweep is therefore both simpler and precise enough:
// no rise/set search machinery to duplicate from that module.

/** Sweep resolution and a defensive cap on sample count — a launch window or
 *  a meteor shower's best local window is a few hours at most; this comfortably
 *  covers that with room to spare for a pathological caller. */
const MOON_SWEEP_STEP_MIN = 15;
const MOON_SWEEP_MAX_SAMPLES = 64;

/**
 * The real `MoonDuringWindow` signal for `window` at `(lat, lon)`: `undefined`
 * when the Moon's altitude never clears 0° anywhere in the window (no
 * penalty — matches skyVisibilityQuality's own "omit when not up" contract);
 * otherwise `{ aboveHorizon: true, illuminationPct }`, where `illuminationPct`
 * is the Moon's actual sunlit-fraction (astronomy-engine `Illumination`) at
 * the sampled instant where it stood highest — the moment moonlight is doing
 * the most to wash out the sky during this window.
 */
function moonDuringWindow(lat: number, lon: number, window: IsoInterval): MoonDuringWindow | undefined {
  const startMs = Date.parse(window.start);
  const endMs = Date.parse(window.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return undefined;

  const observer = new Observer(lat, lon, 0);
  const spanMs = Math.max(endMs - startMs, 0);
  const stepMs = MOON_SWEEP_STEP_MIN * 60_000;
  const steps = Math.min(MOON_SWEEP_MAX_SAMPLES, Math.max(1, Math.floor(spanMs / stepMs) + 1));

  let bestAltitude = -90;
  let illuminationAtBest = 0;
  for (let i = 0; i < steps; i++) {
    const t = steps === 1 ? startMs : startMs + (i * spanMs) / (steps - 1);
    const time = MakeTime(new Date(t));
    const eq = Equator(Body.Moon, time, observer, true, true);
    const hor = Horizon(time, observer, eq.ra, eq.dec, "normal");
    if (hor.altitude > bestAltitude) {
      bestAltitude = hor.altitude;
      illuminationAtBest = Illumination(Body.Moon, time).phase_fraction;
    }
  }

  if (bestAltitude <= 0) return undefined; // never above the horizon in this window
  return { aboveHorizon: true, illuminationPct: Math.round(clamp01(illuminationAtBest) * 100) };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

// --- 3-row cap with reserved rare row (§1) ------------------------------------

/** An eclipse (alone or merged with its full moon) or a launch — either one
 *  reserves its row rather than getting bumped by routine tide/meteor/plain-
 *  moon events when there are more than 3 candidates (§1). Every
 *  `LaunchSkyEvent` reaching this point already cleared the adapter's own
 *  eligibility rules (§7), so "qualified launch" is simply any launch row
 *  that survived `launchRows` above — there is no narrower distinction left
 *  to apply here. */
function isRare(row: SkyEventsCardRow): boolean {
  return row.events.some((e) => e.eventType === "eclipse" || e.eventType === "launch");
}

/** `candidates` must already be sorted chronologically (ascending
 *  `sortInstant`) before calling this. */
function selectRows(candidates: readonly SkyEventsCardRow[]): SkyEventsCardRow[] {
  if (candidates.length <= MAX_ROWS) return candidates.slice();

  const rare = candidates.filter(isRare);
  const routine = candidates.filter((r) => !isRare(r));

  const picked: SkyEventsCardRow[] = [];
  for (const r of rare) {
    if (picked.length >= MAX_ROWS) break;
    picked.push(r);
  }
  for (const r of routine) {
    if (picked.length >= MAX_ROWS) break;
    picked.push(r);
  }

  picked.sort(bySortInstant);
  return picked;
}

// --- small pure helpers --------------------------------------------------------

function bySortInstant(a: SkyEventsCardRow, b: SkyEventsCardRow): number {
  return Date.parse(a.sortInstant) - Date.parse(b.sortInstant);
}

function isFresh(source: { validThrough: IsoInstant }, nowMs: number): boolean {
  const t = Date.parse(source.validThrough);
  return Number.isFinite(t) && nowMs < t;
}

function earlier(a: IsoInstant, b: IsoInstant): IsoInstant {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

const DAY_MS = 86_400_000;

/** yyyy-mm-dd in `tz`, for the "same local night" merge test below. */
function localDayKey(iso: IsoInstant, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Same local calendar day in `tz`, OR within 24h absolute — the local-day
 *  check is the primary signal (matches this plan's local-time framing
 *  throughout), the 24h fallback catches a pairing that straddles local
 *  midnight (the eclipse peaks just after midnight, the exact full-moon
 *  instant lands just before it, or vice versa). */
function sameLocalNight(aIso: IsoInstant, bIso: IsoInstant, tz: string): boolean {
  if (localDayKey(aIso, tz) === localDayKey(bIso, tz)) return true;
  const diff = Math.abs(Date.parse(aIso) - Date.parse(bIso));
  return Number.isFinite(diff) && diff <= DAY_MS;
}
