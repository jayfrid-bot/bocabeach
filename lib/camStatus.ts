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
  /** Who delivers the frames: the home-server courier (via uw-frame) or a county feed. */
  source?: "courier" | "feed";
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
export const FEED_CADENCE = { intervalMin: 30, liveFromMin: 8 * 60, liveToMin: 17 * 60 + 30, source: "feed" } as const;

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
  source: "courier",
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

/** Offset of `tz` from UTC at instant `ms`, in ms (local minus UTC). One Intl call. */
function offsetMs(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(ms / 1000) * 1000;
}

/** Look at most this many local days ahead (a 6-hour floor needs one or two). */
const MAX_DAYS = 40;

/**
 * The instants at which each of `minutes` (ascending) of live time have passed
 * since `fromMs`, in ONE walk over the local days. An instant later than `stopAt`
 * is reported as Infinity: the walk stops at the first day that opens after it,
 * so a fresh cam costs one or two days, never more.
 *
 * One Intl call per day: the day's UTC offset is read at 12:00 UTC (a US morning),
 * which is right for every live window that opens after the 2 AM DST change. All
 * our cams are in US zones with windows from 06:00 on.
 */
export function liveInstantsAfter(
  c: CamCadence,
  fromMs: number,
  minutes: readonly number[],
  stopAt: number = Infinity,
): number[] {
  const out = minutes.map(() => Infinity);
  if (!(c.liveToMin > c.liveFromMin) || minutes.length === 0) return out;
  const start = wallClock(fromMs, c.tz);
  let k = 0;
  let used = 0; // live ms so far
  let day = Date.UTC(start.y, start.m - 1, start.d); // local date as a UTC midnight
  for (let i = 0; i < MAX_DAYS && k < minutes.length; i++, day += 86_400_000) {
    const off = offsetMs(day + 12 * 3_600_000, c.tz);
    const open = Math.max(day + c.liveFromMin * 60_000 - off, fromMs);
    const close = day + c.liveToMin * 60_000 - off;
    if (open > stopAt) break;
    if (close <= open) continue;
    while (k < minutes.length && used + (close - open) >= minutes[k] * 60_000) {
      out[k] = open + (minutes[k] * 60_000 - used);
      k++;
    }
    used += close - open;
  }
  for (let j = 0; j < out.length; j++) if (out[j] > stopAt) out[j] = Infinity;
  return out;
}

/** The instant at which `minutes` of live time have passed since `fromMs` (Infinity if never). */
export function liveInstantAfter(c: CamCadence, fromMs: number, minutes: number): number {
  return liveInstantsAfter(c, fromMs, [minutes])[0];
}

/** Why a cam is offline: its source holds no good frame, or its newest one aged out. */
export type OfflineReason = "none-stored" | "aged";

export interface CamVerdict {
  status: CamStatus;
  /** Set when status is "offline". */
  reason: OfflineReason | null;
  /** When an aged-out cam crossed the line (ms); null otherwise. */
  offlineSinceMs: number | null;
}

const ONLINE: CamVerdict = { status: "online", reason: null, offlineSinceMs: null };

/**
 * The cam's status at `now` (ms), with the reason, in one pass.
 *
 * `lastGoodFrameAt`:
 *   - ISO string: the capture time of the newest good frame the source holds.
 *   - null: the source answered and holds NO good frame (uw-frame meta ok:false,
 *     or a feed whose latest.json no longer lists the view). Offline.
 *   - undefined: we could not ask, or the source gave no usable time. Shown.
 *
 * Rule: offline after max(3 x interval, 6 h) of live time with no good frame;
 * stale after 2 x interval of live time, or when the last attempt since the
 * newest good frame was refused as blank; else online.
 */
export function camVerdict(
  cadence: CamCadence | null,
  lastGoodFrameAt: string | null | undefined,
  lastAttempt: CamAttempt | null | undefined,
  now: number,
): CamVerdict {
  if (!cadence || lastGoodFrameAt === undefined) return ONLINE;
  if (lastGoodFrameAt === null) return { status: "offline", reason: "none-stored", offlineSinceMs: null };
  const good = Date.parse(lastGoodFrameAt);
  if (!Number.isFinite(good)) return ONLINE;
  const [staleAt, offlineAt] = liveInstantsAfter(cadence, good, [staleAfterMin(cadence), offlineAfterMin(cadence)], now);
  if (offlineAt <= now) return { status: "offline", reason: "aged", offlineSinceMs: offlineAt };
  if (staleAt <= now) return { status: "stale", reason: null, offlineSinceMs: null };
  const attemptAt = lastAttempt ? Date.parse(lastAttempt.at) : NaN;
  if (lastAttempt?.blank && Number.isFinite(attemptAt) && attemptAt > good) {
    return { status: "stale", reason: null, offlineSinceMs: null };
  }
  return ONLINE;
}

/** {@link camVerdict}'s status alone. */
export function camStatus(
  cadence: CamCadence | null,
  lastGoodFrameAt: string | null | undefined,
  lastAttempt: CamAttempt | null | undefined,
  now: number,
): CamStatus {
  return camVerdict(cadence, lastGoodFrameAt, lastAttempt, now).status;
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
  const v = camVerdict(cadence, lastGoodFrameAt, null, now);
  return v.offlineSinceMs == null ? null : new Date(v.offlineSinceMs).toISOString();
}

// --- The courier circuit breaker ------------------------------------------------
//
// Every courier cam comes from one home server. If that server stops, uw-frame keeps
// serving each cam's last good frame and all of them age out together: that is ONE
// outage, not 32 dead cams, and hiding them all would empty half the site. So when
// no courier-delivered frame has arrived for 2 live hours (courier clock), no courier
// cam is hidden for age; they stay on the page with their "paused" stamp. A cam whose
// source holds no good frame at all (meta ok:false) is still hidden: it has nothing
// to show. When the fleet state cannot be read, the breaker counts as tripped (fail
// open: shown).

/** No courier frame for this many live minutes = the courier as a whole is down. */
export const COURIER_FLEET_STALE_MIN = 120;

export type CourierFleet = { down: false } | { down: true; sinceMs: number | null } | { down: "unknown" };

/**
 * The courier fleet's state from its newest courier-delivered good frame:
 * ISO = that frame's time, null = none at all on record, undefined = not read.
 */
export function courierFleet(newestCourierGoodAt: string | null | undefined, now: number): CourierFleet {
  if (newestCourierGoodAt === undefined) return { down: "unknown" };
  if (newestCourierGoodAt === null) return { down: true, sinceMs: null };
  const t = Date.parse(newestCourierGoodAt);
  if (!Number.isFinite(t)) return { down: "unknown" };
  const at = liveInstantAfter({ ...COURIER_CADENCE }, t, COURIER_FLEET_STALE_MIN);
  return at <= now ? { down: true, sinceMs: at } : { down: false };
}

/** A courier cam's verdict after the breaker: aged-out becomes stale while the fleet is down or unknown. */
export function withCourierBreaker(v: CamVerdict, isCourierCam: boolean, fleet: CourierFleet): CamVerdict {
  if (!isCourierCam || v.reason !== "aged" || fleet.down === false) return v;
  return { status: "stale", reason: null, offlineSinceMs: null };
}

/** True for a cam whose frames come from the home-server courier. */
export const isCourierCadence = (c: CamCadence | null): boolean => c?.source === "courier";

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

/**
 * The roster's offline cams at `now`, longest-down first (unknown "since" first of
 * all). `fleet` is the courier breaker: while the courier as a whole is down (or not
 * read), courier cams are not listed for age; the report says "courier down" once.
 */
export function listOfflineCams(
  roster: readonly RosterCam[],
  evidence: readonly CamEvidence[],
  now: number,
  fleet: CourierFleet = { down: "unknown" },
): OfflineCam[] {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const out: OfflineCam[] = [];
  for (const cam of roster) {
    const ev = byId.get(cam.id);
    if (!ev) continue;
    const v = withCourierBreaker(
      camVerdict(cam.cadence, ev.lastGoodFrameAt, ev.lastAttempt, now),
      isCourierCadence(cam.cadence),
      fleet,
    );
    if (v.status !== "offline") continue;
    out.push({
      id: cam.id,
      slug: cam.slug,
      name: cam.name,
      since: v.offlineSinceMs == null ? null : new Date(v.offlineSinceMs).toISOString(),
      lastGoodFrameAt: ev.lastGoodFrameAt ?? null,
      lastAttempt: ev.lastAttempt ?? null,
    });
  }
  return out.sort((a, b) => (a.since ?? "").localeCompare(b.since ?? "") || a.id.localeCompare(b.id));
}

/**
 * The newest courier-delivered good frame in a uw-frame `/cams` answer (ISO), null
 * when it lists none, undefined when the answer is not a cam list.
 */
export function newestCourierFrame(camsJson: unknown): string | null | undefined {
  const cams = (camsJson as { cams?: unknown } | null)?.cams;
  if (!Array.isArray(cams)) return undefined;
  let best: number | null = null;
  for (const c of cams as { ok?: unknown; source?: unknown; grabbedAtUtc?: unknown }[]) {
    if (c?.ok !== true || c.source !== "courier" || typeof c.grabbedAtUtc !== "string") continue;
    const t = Date.parse(c.grabbedAtUtc);
    if (Number.isFinite(t) && (best == null || t > best)) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}
