// Pure timing behind the Golden hour card's headline and timeline track.
// Answers one question — "where am I relative to the next golden hour?" — from
// the real elevation windows (sun +6°→−4°, see lib/sources/sun.ts). Kept out of
// the JSX so the decision is testable and deterministic: same inputs → same
// output on the server render and on hydration alike.
//
// NOTE: this is deliberately NOT lib/sunQuality.ts's `nextSunEvent`. That picks
// the next sunrise/sunset EVENT; a golden window straddles its event, so from
// sunset until the window closes the next event is already tomorrow's sunrise
// while you are still standing in tonight's golden hour. The card's countdown
// has to follow the WINDOW, not the event.

/** Anything that can name an instant. Strings are parsed as ISO. */
export type TimeLike = Date | string | number;

/** One golden window, plus the peak-color anchor for its side when known. */
export interface GoldenWindowInput {
  start?: TimeLike;
  end?: TimeLike;
  /** Sun ~−3° crossing on this side — passed through for the color line. */
  peakAnchorIso?: string;
}

export type GoldenPhase = "before" | "during" | "after-today" | "none";

/** Which window the card is talking about. */
export interface GoldenTarget {
  /** Morning window (straddles sunrise) or evening window (straddles sunset). */
  kind: "am" | "eve";
  /** Which day the window belongs to. */
  day: "today" | "tomorrow";
  start: Date;
  end: Date;
  /** The sunrise/sunset this window straddles, ISO, when the caller supplied it. */
  eventIso?: string;
  /** Peak-color anchor (sun ~−3°), ISO, when known. */
  peakAnchorIso?: string;
}

export interface GoldenHourTimingArgs {
  /** Instant to read the clock at. Pin this to a snapshot time for SSR. */
  now: TimeLike;
  /** Today's real elevation windows. Either side may be absent. */
  windows: { am?: GoldenWindowInput; eve?: GoldenWindowInput };
  /** Today's sunrise/sunset — the event inside each window. */
  sunrise?: TimeLike;
  sunset?: TimeLike;
  /** Tomorrow's morning window, used once today's windows are done. */
  tomorrowAmWindow?: GoldenWindowInput;
  /** Tomorrow's sunrise — the event inside `tomorrowAmWindow`. */
  tomorrowSunrise?: TimeLike;
  /** Clock formatter for the "Next golden hour 6:26 AM" headline, e.g.
   *  `(d) => fmtTime(d.toISOString(), tz)`. Without it the headline falls back
   *  to a pure countdown, so this module stays timezone-free. */
  formatTime?: (d: Date) => string;
}

export interface GoldenHourTiming {
  phase: GoldenPhase;
  /** The window the phase is about; null only when phase is "none". */
  target: GoldenTarget | null;
  /** ms until the window opens — set for "before" and "after-today". */
  msUntilStart: number | null;
  /** ms until the window closes — set for "during". */
  msUntilEnd: number | null;
  /** Lead line, e.g. "Golden hour in 2h 14m" / "Golden hour now". */
  headline: string;
  /** Small trailing figure, e.g. "23 min left" / "in 9h 26m". Null when none. */
  badge: string | null;
  /** headline + badge, e.g. "Golden hour now · 23 min left". */
  label: string;
}

function ms(t: TimeLike | undefined): number {
  if (t == null) return Number.NaN;
  if (t instanceof Date) return t.getTime();
  if (typeof t === "number") return t;
  return Date.parse(t);
}

function isoOf(t: TimeLike | undefined): string | undefined {
  const v = ms(t);
  return Number.isFinite(v) ? new Date(v).toISOString() : undefined;
}

/**
 * Compact duration: "2h 14m", "48m", "<1m". Rounds DOWN to the minute so a
 * countdown never reads a minute richer than it is. Negative/non-finite → "<1m".
 */
export function formatDuration(msSpan: number): string {
  if (!Number.isFinite(msSpan) || msSpan < 60_000) return "<1m";
  const totalMin = Math.floor(msSpan / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** "23 min left" under an hour, "1h 4m left" above it. */
function remainingPhrase(msSpan: number): string {
  if (!Number.isFinite(msSpan) || msSpan < 60_000) return "<1 min left";
  const totalMin = Math.floor(msSpan / 60_000);
  if (totalMin < 60) return `${totalMin} min left`;
  return `${formatDuration(msSpan)} left`;
}

interface Candidate {
  kind: "am" | "eve";
  day: "today" | "tomorrow";
  startMs: number;
  endMs: number;
  eventIso?: string;
  peakAnchorIso?: string;
}

function candidate(
  kind: "am" | "eve",
  day: "today" | "tomorrow",
  w: GoldenWindowInput | undefined,
  event: TimeLike | undefined,
): Candidate | null {
  if (!w) return null;
  const startMs = ms(w.start);
  const endMs = ms(w.end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  return { kind, day, startMs, endMs, eventIso: isoOf(event), peakAnchorIso: w.peakAnchorIso };
}

function toTarget(c: Candidate): GoldenTarget {
  return {
    kind: c.kind,
    day: c.day,
    start: new Date(c.startMs),
    end: new Date(c.endMs),
    eventIso: c.eventIso,
    peakAnchorIso: c.peakAnchorIso,
  };
}

function none(headline: string): GoldenHourTiming {
  return {
    phase: "none",
    target: null,
    msUntilStart: null,
    msUntilEnd: null,
    headline,
    badge: null,
    label: headline,
  };
}

/**
 * Where `now` stands relative to the next golden hour.
 *
 * - inside today's morning or evening window → "during" ("Golden hour now ·
 *   23 min left")
 * - before a window that still comes today → "before" ("Golden hour in 2h 14m")
 * - today's windows are done → "after-today", pointing at tomorrow's morning
 *   window ("Next golden hour 6:26 AM · in 9h 26m")
 * - no usable window at all (high latitude, or missing sun times) → "none",
 *   with honest copy instead of a guess.
 *
 * Pure — `now` is injected, so the caller owns determinism.
 */
export function goldenHourTiming(args: GoldenHourTimingArgs): GoldenHourTiming {
  const nowMs = ms(args.now);
  if (!Number.isFinite(nowMs)) return none("Golden hour times unavailable");

  const todayAm = candidate("am", "today", args.windows.am, args.sunrise);
  const todayEve = candidate("eve", "today", args.windows.eve, args.sunset);
  const tomorrowAm = candidate("am", "tomorrow", args.tomorrowAmWindow, args.tomorrowSunrise);

  if (!todayAm && !todayEve && !tomorrowAm) return none("Golden hour times unavailable");

  // Inside a window? Bounds are inclusive at both ends, matching the card's
  // in-window progress track.
  const inside = [todayAm, todayEve, tomorrowAm].find(
    (c): c is Candidate => !!c && nowMs >= c.startMs && nowMs <= c.endMs,
  );
  if (inside) {
    const msUntilEnd = inside.endMs - nowMs;
    const headline = "Golden hour now";
    const badge = remainingPhrase(msUntilEnd);
    return {
      phase: "during",
      target: toTarget(inside),
      msUntilStart: null,
      msUntilEnd,
      headline,
      badge,
      label: `${headline} · ${badge}`,
    };
  }

  // Otherwise the soonest window that hasn't opened yet.
  const upcoming = [todayAm, todayEve, tomorrowAm]
    .filter((c): c is Candidate => !!c && c.startMs > nowMs)
    .sort((a, b) => a.startMs - b.startMs)[0];

  if (!upcoming) return none("No more golden hour today");

  const msUntilStart = upcoming.startMs - nowMs;

  if (upcoming.day === "today") {
    const headline = `Golden hour in ${formatDuration(msUntilStart)}`;
    return {
      phase: "before",
      target: toTarget(upcoming),
      msUntilStart,
      msUntilEnd: null,
      headline,
      badge: null,
      label: headline,
    };
  }

  const at = args.formatTime?.(new Date(upcoming.startMs));
  const headline = at ? `Next golden hour ${at}` : "Next golden hour";
  const badge = `in ${formatDuration(msUntilStart)}`;
  return {
    phase: "after-today",
    target: toTarget(upcoming),
    msUntilStart,
    msUntilEnd: null,
    headline,
    badge,
    label: `${headline} · ${badge}`,
  };
}

/** Fraction 0-1 of `value` across [min,max], clamped. Used for track geometry. */
function clamp01(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

/** How far before the window the timeline track starts (minutes). */
export const TRACK_LEAD_MINUTES = 90;
/** How far past the window the timeline track runs (minutes). */
export const TRACK_TAIL_MINUTES = 30;

export interface GoldenTrack {
  /** Track span (ms) — window start − lead, window end + tail. */
  spanStartMs: number;
  spanEndMs: number;
  /** Percent positions along the track (0-100). */
  startPct: number;
  endPct: number;
  /** The sunrise/sunset tick; null when no event time was supplied. */
  eventPct: number | null;
  /** The "now" marker, clamped into the track. */
  nowPct: number;
  /** True when `now` sits outside the drawn span (marker pinned to an edge). */
  nowOutside: boolean;
}

/**
 * Geometry for the card's timeline track: a fixed span around the target
 * window, with the window, the sun event and "now" placed as percentages.
 * Pure, so the server and the client draw the same track from the same `now`.
 */
export function goldenTrack(target: GoldenTarget, now: TimeLike): GoldenTrack {
  const startMs = target.start.getTime();
  const endMs = target.end.getTime();
  const spanStartMs = startMs - TRACK_LEAD_MINUTES * 60_000;
  const spanEndMs = endMs + TRACK_TAIL_MINUTES * 60_000;
  const pct = (t: number): number => clamp01(t, spanStartMs, spanEndMs) * 100;

  const nowMs = ms(now);
  const eventMs = target.eventIso ? Date.parse(target.eventIso) : Number.NaN;

  return {
    spanStartMs,
    spanEndMs,
    startPct: pct(startMs),
    endPct: pct(endMs),
    eventPct:
      Number.isFinite(eventMs) && eventMs >= spanStartMs && eventMs <= spanEndMs
        ? pct(eventMs)
        : null,
    nowPct: pct(nowMs),
    nowOutside: !Number.isFinite(nowMs) || nowMs < spanStartMs || nowMs > spanEndMs,
  };
}
