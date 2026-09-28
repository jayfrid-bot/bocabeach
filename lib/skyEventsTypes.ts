// Shared domain types for the "Coming up" sky-events card and its Plus
// alerts (see docs/SKY_EVENTS_PLAN.md, Phase 0). Dependency-free except for
// the canonical `Wrapped<T>` envelope, which this module imports rather
// than redefining — every other source in the app wraps its data the same
// way (lib/types.ts), and sky events are no exception.
//
// Every instant in this module is a UTC ISO 8601 string (e.g.
// "2026-10-03T23:12:00Z"). Formatting into a beach's own IANA timezone
// happens only at the display edge (SKY_EVENTS_PLAN.md §9) — nothing typed
// by this file should ever carry a local-time string.
//
// This file defines types only — no I/O, no fetching, no rating math, no
// merge logic. Later crews (Phase 1 adapters, Phase 2 rating/aggregation,
// Phase 3 alerts) build against these shapes; changing them after Phase 1
// starts means re-coordinating every crew, so review changes here
// carefully.

import type { Wrapped } from "@/lib/types";

// --- Time --------------------------------------------------------------

/** A UTC ISO 8601 instant, e.g. "2026-10-03T23:12:00Z". Branded only in
 *  spirit — TypeScript can't enforce the format — but every field typed
 *  `IsoInstant` is a promise that it's UTC, never a local time string. */
export type IsoInstant = string;

/** A half-open UTC interval `[start, end)`. Used for an eclipse's
 *  intersected visible window, a meteor shower's best local observing
 *  window, a full-moon/supermoon viewing window, and a tide episode's
 *  first-to-last qualifying high. */
export interface IsoInterval {
  start: IsoInstant;
  end: IsoInstant;
}

// --- Rating (§5) ---------------------------------------------------------

/** The one-word sky-visibility rating, reusing `SUN_QUALITY_BANDS`'
 *  labels/colors (lib/sunQuality.ts) — a new scoring curve, same
 *  presentation layer. No `SkyRating` at all (rather than a guessed one)
 *  means "no badge" — a missing forecast is never guessed (§5, §1). */
export type SkyRatingLabel = "Poor" | "Fair" | "Good" | "Great" | "Amazing";

export interface SkyRating {
  label: SkyRatingLabel;
  /** The interval this rating was actually sampled over: an eclipse's
   *  visible window, a meteor shower's best local window, a full-moon/
   *  supermoon viewing window, or a single-instant interval (`start ===
   *  end`) for a tide/launch event's nearest forecast hour (§5). */
  sampledOver: IsoInterval;
}

// --- Where to look (§4, §7) ----------------------------------------------

/** A plain-English "where to look" hint. `bearingDeg` is the great-circle
 *  bearing from the beach to the target (moonrise point or launch pad),
 *  0-360, always computed server-side — the client gets this one number
 *  and `line`, never raw trig inputs (§4, §7, §9). */
export interface WhereToLook {
  bearingDeg: number;
  /** The copy layer's own words, e.g. "over the water", "bearing 349°
   *  (nearly due north)" — not derived client-side from `bearingDeg`. */
  line: string;
}

// --- Source / freshness (§3, §8, §9) --------------------------------------

/** Every sky event carries the same provenance every other `Wrapped`
 *  source does, plus an event-level `validThrough` distinct from feed
 *  freshness: an event is only shown while `now < validThrough`, even if
 *  the feed itself is still within its own staleness gate (§3, §8). */
export interface SkyEventSource {
  /** The originating feed's own `generatedAt`. */
  feedGeneratedAt: IsoInstant;
  /** Event-level expiry (§3's `validThrough`, §8's staleness gates). */
  validThrough: IsoInstant;
}

// --- The five card event shapes -------------------------------------------

/** The five kinds of row the "Coming up" card can show. A full moon and a
 *  supermoon are the same underlying event (`"moon"`) — `isSupermoon` is a
 *  flag on it, not a separate kind — because a supermoon is nothing but a
 *  full moon whose Nolle closeness ratio clears the bar (§4). The alert
 *  side (§10) still needs its own, narrower discriminant; see
 *  `SkyAlertEventType` below. */
export type SkyEventType = "tide" | "eclipse" | "moon" | "meteor" | "launch";

export interface TideSkyEvent {
  eventType: "tide";
  /** "validated" = crosses a `representative: true` station's flood
   *  threshold, same datum throughout (§3 tier 1, the only alert-eligible
   *  tide tier). "very-high" = card-only top-1%-of-the-year tier (§3 tier
   *  2, never alert-eligible). */
  tier: "validated" | "very-high";
  stationId: string;
  /** The datum both the prediction and (for `"validated"`) the threshold
   *  were compared in — never mixed across stations or datums (§3). */
  datum: string;
  /** The episode's first-to-last qualifying high, after the deterministic
   *  merge (consecutive highs ≤30h apart, ≤72h total span, §3). */
  episode: IsoInterval;
  heightFt: number;
  /** Tides are never sky-rated (§5 doesn't sample them). */
  rating: null;
  source: SkyEventSource;
}

export interface EclipseSkyEvent {
  eventType: "eclipse";
  /** Penumbral is never surfaced — only partial and total reach the card
   *  (§4). */
  kind: "partial" | "total";
  peak: IsoInstant;
  /** True only when `peak` itself falls inside `visible` — this is what
   *  picks between the two eclipse copy forms in §12 ("peak 1:58 AM" vs
   *  "visible here from 1:10-1:42 AM"). */
  peakIsVisible: boolean;
  /** The phase's contact interval intersected with the Moon's altitude
   *  staying ≥5° at the beach; always ≥15 minutes long whenever this
   *  event exists at all (§4's round-3 fix — anything shorter is simply
   *  not shown). */
  visible: IsoInterval;
  rating: SkyRating | null;
  source: SkyEventSource;
}

export interface MoonSkyEvent {
  eventType: "moon";
  fullMoonInstant: IsoInstant;
  /** The Nolle closeness ratio, always computed (even when < 0.90) so a
   *  near-miss is inspectable in tests, not just a boolean. */
  closeness: number;
  isSupermoon: boolean;
  /** Set only when `isSupermoon` is true and this is the year's closest;
   *  1 = "closest full moon of the year" copy is allowed (§4, §12). Never
   *  set on a non-#1 supermoon. */
  supermoonRank?: number;
  /** The universal ≥5°-altitude viewing window near the full-moon instant
   *  — computed for **all 39 beaches**, independent of whether the shore
   *  normal has been reviewed (§4's round-3 fix). This is what §5's
   *  rating and §10's alert-eligibility check both sample. */
  viewingWindow: IsoInterval;
  moonriseLocal: IsoInstant;
  /** Present only at curated beaches with a manually reviewed
   *  `coastNormalDeg` (today: 3 of 39). Its presence is what gates the
   *  "rises over the water" copy — a second, independent check layered on
   *  top of `viewingWindow`, never required for the event itself to show
   *  (§4). */
  overWater?: WhereToLook;
  rating: SkyRating | null;
  source: SkyEventSource;
}

export interface MeteorSkyEvent {
  eventType: "meteor";
  showerId: string;
  showerName: string;
  peak: IsoInstant;
  /** The shower's published activity window (start/end), not just the
   *  peak date (§6). */
  activityWindow: IsoInterval;
  /** The best local interval where the radiant is above the horizon and
   *  the sky is dark, computed per beach (§5, §6) — not the same for
   *  every beach the way `activityWindow` is. */
  bestLocalWindow: IsoInterval;
  radiantRaDeg: number;
  radiantDecDeg: number;
  zhr: number;
  /** The config entry's source edition/year it was transcribed from
   *  (IMO/AMS calendar), so a stale transcription is traceable (§6). */
  sourceEdition: string;
  rating: SkyRating | null;
}

export interface LaunchSkyEvent {
  eventType: "launch";
  /** LL2's own UUID — the stable identity a card row, a dedupe key, and
   *  an alert all key on; the same UUID always updates the same row in
   *  place (§7, §10). */
  ll2Id: string;
  name: string;
  net: IsoInstant;
  netPrecision: "Minute" | "Hour" | "Day" | "Month" | "Quarter" | "Year" | "Unknown";
  windowStart: IsoInstant;
  windowEnd: IsoInstant;
  status: "Go" | "TBD" | "Hold" | "Success" | "Failure" | "Cancelled" | "In Flight";
  padId: number;
  padLocationId: number;
  /** Solar altitude at the OBSERVER's location at `net`: day = ≥0°,
   *  twilight = −18° to <0°, night = <−18° (§7). */
  observerLightState: "day" | "twilight" | "night";
  /** Same three states, evaluated at the pad's own location — the
   *  observer and the pad can differ at the same instant (§7). */
  padLightState: "day" | "twilight" | "night";
  /** near = ≤50mi (any launch), mid = 50-200mi (known-orbital + observer
   *  below 0° only), far = >200mi (never shown, §7 — a `far`-tier launch
   *  is filtered out before it becomes a `LaunchSkyEvent` at all). */
  rangeTier: "near" | "mid";
  /** True only via LL2's own `mission.orbit` allowlist match — never
   *  inferred from the rocket/mission name; missing or unrecognized orbit
   *  data means `false` (§7). */
  knownOrbital: boolean;
  whereToLook: WhereToLook;
  rating: SkyRating | null;
  source: SkyEventSource;
}

/** The merged event union every Phase 1 adapter, Phase 2 rating/aggregator,
 *  and Phase 3 alert builds against. */
export type SkyEvent = TideSkyEvent | EclipseSkyEvent | MoonSkyEvent | MeteorSkyEvent | LaunchSkyEvent;

/** Every `SkyEvent["eventType"]` value, for iteration/tests. Keep this in
 *  sync with `SkyEvent` by hand — `assertSkyEventTypesExhaustive` below
 *  fails to compile if a kind is added to the union and not to this
 *  array. */
export const SKY_EVENT_TYPES: readonly SkyEventType[] = ["tide", "eclipse", "moon", "meteor", "launch"] as const;

// --- Alert-side discriminant (§10) ----------------------------------------

/** The exact 5-value discriminant the single `"coming-up"` `AlertSubject`
 *  variant carries (SKY_EVENTS_PLAN.md §10) — narrower than
 *  `SkyEventType`: a plain (non-super) full moon is card-only and never
 *  reaches an `AlertSubject`, so `"moon"` does not appear here —
 *  `"supermoon"` does, and only when `MoonSkyEvent.isSupermoon` is true.
 *  Defined here, not in lib/alerts/catalog.ts, so Phase 0 stays
 *  dependency-free of the alert stack while still giving Phase 3 (and
 *  everyone else) one shared name for it. */
export type SkyAlertEventType = "eclipse" | "tide" | "meteor" | "supermoon" | "launch";

export const SKY_ALERT_EVENT_TYPES: readonly SkyAlertEventType[] = [
  "eclipse",
  "tide",
  "meteor",
  "supermoon",
  "launch",
] as const;

// --- Card composition (§1, §9) ---------------------------------------------

/** One row of the "Coming up" card. Usually one `SkyEvent`; occasionally
 *  two merged into a single row (e.g. "Total eclipse during the full
 *  moon", §1) — `events` holds every underlying event the row represents,
 *  in the order they should be described. */
export interface SkyEventsCardRow {
  events: readonly SkyEvent[];
  /** The row's own display instant — the merged row's chronological
   *  position on the card (§1, §9's snapshot-pinned rendering; never
   *  `Date.now()`). */
  sortInstant: IsoInstant;
}

/** The full "Coming up" card payload for one beach: at most 3 rows,
 *  nearest first (§1), pinned to the conditions snapshot's own
 *  `generatedAt` (§9). */
export interface SkyEventsCardData {
  rows: readonly SkyEventsCardRow[];
  generatedAt: IsoInstant;
}

// --- Per-adapter Wrapped<T> contracts (§13 Phase 1/2) -----------------------
//
// The interfaces Phase 1's four adapters (Crews A-D) are built against, and
// Phase 2B's aggregator (Crew F) merges — agreed up front so Phase 2 can
// start against these shapes before Phase 1's internals are done.

export type WrappedTideEvents = Wrapped<TideSkyEvent[]>;
export type WrappedMoonEvents = Wrapped<(EclipseSkyEvent | MoonSkyEvent)[]>;
export type WrappedMeteorEvents = Wrapped<MeteorSkyEvent[]>;
export type WrappedLaunchEvents = Wrapped<LaunchSkyEvent[]>;

// --- Data-branch feed schemas (§7, §8, §9) ---------------------------------
//
// The untrusted JSON published to the `king-tide-data` and `launch-data`
// orphan branches. Every payload carries `schemaVersion` so an adapter can
// reject a shape it doesn't understand instead of guessing (§9's
// untrusted-feed-JSON rules: schema/version check, size limit, timestamp
// sanity, coordinate-range sanity, enum allowlists, completeness).

export interface KingTideHigh {
  episode: IsoInterval;
  heightFt: number;
  tier: "validated" | "very-high";
}

export interface KingTideStationFeed {
  stationId: string;
  /** The datum predictions and the threshold were both fetched/compared
   *  in for this station (§3 — verified live as STND at the two stations
   *  checked, never assumed). */
  datum: string;
  /** The hand-reviewed flag from Phase 1 config (§3, §13 Crew D) — carried
   *  through to the feed so the adapter never has to re-derive it. */
  representative: boolean;
  nwsMinorFt: number | null;
  nosMinorFt: number | null;
  /** Top-1% threshold height, keyed by station-local calendar year (e.g.
   *  "2026"), covering the current and next year (§3). */
  percentileByYear: Record<string, number>;
  /** This station's qualifying highs, already episode-merged (§3) — the
   *  feed never ships raw unmerged hilo rows to the app. */
  highs: readonly KingTideHigh[];
  validThrough: IsoInstant;
}

export interface KingTideFeedPayload {
  schemaVersion: 1;
  generatedAt: IsoInstant;
  stations: readonly KingTideStationFeed[];
}

export interface LaunchFeedEntry {
  id: string;
  name: string;
  net: IsoInstant;
  netPrecision: LaunchSkyEvent["netPrecision"];
  windowStart: IsoInstant;
  windowEnd: IsoInstant;
  status: LaunchSkyEvent["status"];
  padId: number;
  padLocationId: number;
  /** Present only when LL2's own `mission.orbit` field matched the
   *  allowlist (§7); `null` means unknown/unrecognized, never assumed
   *  orbital. */
  orbitAbbrev: string | null;
  lastUpdated: IsoInstant;
}

export interface LaunchFeedPayload {
  schemaVersion: 1;
  generatedAt: IsoInstant;
  launches: readonly LaunchFeedEntry[];
}
