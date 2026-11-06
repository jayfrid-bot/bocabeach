// Is a beach cam up, late, or down? One pure rule, so the page, the JSON feeds and
// the owner's daily scorecard all hide the same cams for the same reason.
//
// A dead stream produces no new frames: the courier's grabs are refused as blank
// (HTTP 422) and the last good frame just gets older. So "down" is judged on the age
// of the last GOOD frame, counted only in the hours the cam is expected to deliver
// one. A cam that only uploads by day, or that the courier polls only in the day,
// keeps its status overnight instead of vanishing every evening.
//
// No flapping: between good frames the age only grows, and the clock stops outside
// the live hours, so a cam cannot cross a line back and forth. It leaves "offline"
// only on a new good frame, which puts it straight back to "online". There is no
// stored state, so nothing to reset by hand and nothing to deploy when a cam returns.
//
// Unknown is not offline: when the lookup itself failed (a provider burst, a timeout)
// the cam stays shown, as it always was. Only positive evidence hides a cam.

import type { CamConfig } from "@/lib/types";

export type CamStatus = "online" | "stale" | "offline";

/** When a cam is expected to deliver frames, and how often. */
export interface CamCadence {
  /** Expected minutes between good frames inside the live hours. */
  intervalMin: number;
  /** Live hours, in minutes after local midnight in `tz` ([from, to), to > from). */
  liveFromMin: number;
  liveToMin: number;
  /** The clock the live hours are read in. */
  tz: string;
}

/** The last refused or failed grab, when the source reports one. */
export interface CamAttempt {
  /** ISO time of the attempt. */
  at: string;
  /** True when the frame was refused as blank (YouTube's slate, a black frame). */
  blank: boolean;
}

/**
 * video-monitoring.com county cams (Boca, Jupiter, Martin County, Sebastian):
 * a new still every few minutes, uploaded about 8:00 AM to 5:30 PM local time.
 */
export const FEED_CADENCE = { intervalMin: 30, liveFromMin: 8 * 60, liveToMin: 17 * 60 + 30 } as const;

/**
 * Courier cams (YouTube streams grabbed by the home server and stored by the
 * uw-frame Worker): a frame about every hour, and only 06:00-20:59 Eastern, the
 * courier's daylight gate (scripts/courier_schedule.py daylight_eastern). The
 * courier's clock is Eastern for every cam, Central-time beaches included.
 */
export const COURIER_CADENCE = {
  intervalMin: 60,
  liveFromMin: 6 * 60,
  liveToMin: 21 * 60,
  tz: "America/New_York",
} as const;

/** Never call a cam down on less than this many live hours of silence. */
export const OFFLINE_FLOOR_MIN = 6 * 60;

/** Live minutes of silence after which the cam is hidden: max(3 x interval, 6 h). */
export function offlineAfterMin(c: CamCadence): number {
  return Math.max(3 * c.intervalMin, OFFLINE_FLOOR_MIN);
}

/** Live minutes of silence after which the cam is "stale" (still shown): 2 x interval. */
export function staleAfterMin(c: CamCadence): number {
  return 2 * c.intervalMin;
}

/**
 * The cadence of a configured cam, from the config fields it already has. null =
 * nothing to judge (a link-out or a video embed, or a still with no time source),
 * so the cam is always shown.
 */
export function camCadence(cam: CamConfig, beachTz: string): CamCadence | null {
  if (cam.embedType !== "image" || !cam.id) return null;
  if (cam.snapshotMetaUrl) return { ...COURIER_CADENCE };
  if (cam.snapshotFeed) return { ...FEED_CADENCE, tz: beachTz };
  return null;
}

// --- Time-zone arithmetic (no library; a handful of Intl calls per cam) ----------

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    partsFmt.set(tz, f);
  }
  return f;
}

interface WallClock {
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallClock(ms: number, tz: string): WallClock {
  const out: Record<string, number> = {};
  for (const p of fmtFor(tz).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute, s: out.second };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (local minus UTC). */
function offsetMs(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local date (y, m, d) at `minutes` after midnight in `tz`. */
function localInstant(y: number, m: number, d: number, minutes: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const first = guess - offsetMs(guess, tz);
  const second = guess - offsetMs(first, tz);
  return second;
}

/** Look at most this many local days ahead (a 6-hour floor needs one or two). */
const MAX_DAYS = 40;

/**
 * The instant at which `minutes` of live time have passed since `fromMs`.
 * Infinity when the live window is empty.
 */
export function liveInstantAfter(c: CamCadence, fromMs: number, minutes: number): number {
  if (!(c.liveToMin > c.liveFromMin)) return Infinity;
  let left = minutes * 60_000;
  const start = wallClock(fromMs, c.tz);
  // Walk local calendar days with a UTC-noon cursor (immune to DST shifts).
  let day = Date.UTC(start.y, start.m - 1, start.d, 12);
  for (let i = 0; i < MAX_DAYS; i++, day += 86_400_000) {
    const dt = new Date(day);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const open = Math.max(localInstant(y, m, d, c.liveFromMin, c.tz), fromMs);
    const close = localInstant(y, m, d, c.liveToMin, c.tz);
    if (close <= open) continue;
    if (close - open >= left) return open + left;
    left -= close - open;
  }
  return Infinity;
}

/**
 * The cam's status at `now` (ms).
 *
 * `lastGoodFrameAt`:
 *   - ISO string: the capture time of the newest good frame the source holds.
 *   - null: the source answered and holds NO good frame (uw-frame meta ok:false,
 *     or a feed whose latest.json no longer lists the view). Offline.
 *   - undefined: we could not ask (the lookup failed). Shown, as before.
 *
 * Rule: offline after max(3 x interval, 6 h) of live time with no good frame;
 * stale after 2 x interval of live time, or when the last attempt since the
 * newest good frame was refused as blank; else online.
 */
export function camStatus(
  cadence: CamCadence | null,
  lastGoodFrameAt: string | null | undefined,
  lastAttempt: CamAttempt | null | undefined,
  now: number,
): CamStatus {
  if (!cadence || lastGoodFrameAt === undefined) return "online";
  if (lastGoodFrameAt === null) return "offline";
  const good = Date.parse(lastGoodFrameAt);
  if (!Number.isFinite(good)) return "online";
  if (liveInstantAfter(cadence, good, offlineAfterMin(cadence)) <= now) return "offline";
  if (liveInstantAfter(cadence, good, staleAfterMin(cadence)) <= now) return "stale";
  const attemptAt = lastAttempt ? Date.parse(lastAttempt.at) : NaN;
  if (lastAttempt?.blank && Number.isFinite(attemptAt) && attemptAt > good) return "stale";
  return "online";
}

/**
 * When the cam went offline (ISO), for the owner's report: the moment its live
 * silence crossed the line. null when unknown (no good frame on record) or when
 * the cam is not offline at `now`.
 */
export function camOfflineSince(
  cadence: CamCadence | null,
  lastGoodFrameAt: string | null | undefined,
  now: number,
): string | null {
  if (!cadence || !lastGoodFrameAt) return null;
  const good = Date.parse(lastGoodFrameAt);
  if (!Number.isFinite(good)) return null;
  const at = liveInstantAfter(cadence, good, offlineAfterMin(cadence));
  return at <= now ? new Date(at).toISOString() : null;
}

// --- The owner's list (the daily scorecard) ---------------------------------------

/** One configured cam the rule can judge. */
export interface RosterCam {
  id: string;
  slug: string;
  name: string;
  cadence: CamCadence;
}

/** Every configured cam the rule can judge, from the beach config. */
export function camRoster(
  locations: readonly { slug: string; timezone: string; cams: readonly CamConfig[] }[],
): RosterCam[] {
  const out: RosterCam[] = [];
  for (const loc of locations) {
    for (const cam of loc.cams) {
      const cadence = camCadence(cam, loc.timezone);
      if (cadence && cam.id) out.push({ id: cam.id, slug: loc.slug, name: cam.name, cadence });
    }
  }
  return out;
}

/** What a source said about one cam (null/undefined as in camStatus). */
export interface CamEvidence {
  id: string;
  lastGoodFrameAt: string | null | undefined;
  lastAttempt?: CamAttempt | null;
}

export interface OfflineCam {
  id: string;
  slug: string;
  name: string;
  /** When it went offline (ISO), or null when no good frame is on record. */
  since: string | null;
  /** The newest good frame the source still knows of (ISO), or null. */
  lastGoodFrameAt: string | null;
  /** The last refused or failed grab, when the source reports one. */
  lastAttempt: CamAttempt | null;
}

/** The roster's offline cams at `now`, longest-down first (unknown "since" first of all). */
export function listOfflineCams(roster: readonly RosterCam[], evidence: readonly CamEvidence[], now: number): OfflineCam[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const out: OfflineCam[] = [];
  for (const cam of roster) {
    const ev = byId.get(cam.id);
    if (!ev) continue;
    if (camStatus(cam.cadence, ev.lastGoodFrameAt, ev.lastAttempt, now) !== "offline") continue;
    out.push({
      id: cam.id,
      slug: cam.slug,
      name: cam.name,
      since: camOfflineSince(cam.cadence, ev.lastGoodFrameAt, now),
      lastGoodFrameAt: ev.lastGoodFrameAt ?? null,
      lastAttempt: ev.lastAttempt ?? null,
    });
  }
  return out.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "") || a.id.localeCompare(b.id));
}
