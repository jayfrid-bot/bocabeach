// Which capture group of a cam feed (cam_seaweed.<slug>.json) a SEAWEED or WATER
// reader should use. scripts/cam_seaweed.py publishes these groups:
//   latest       the newest capture. At low sun (dusk, dawn) its cams publish no
//                seaweed or water, but its crowd counts are still good.
//   lastSeaweed  today's newest capture with at least one published seaweed level.
//   lastWater    today's newest capture where some cam read open water. Kept apart
//                from lastSeaweed: their validity diverges (a held seaweed claim
//                still has good water; a seaweed-valid capture can show none).
//   morning      today's best early capture (5 AM to noon).
// Crowd readers (busyness) keep using `latest`. Seaweed readers try latest,
// lastSeaweed, morning; water readers try latest, lastWater, morning. The first
// group with a usable reading wins, and it keeps its own `capturedAtLocal`, so the
// card can say when it was read.
//
// LOCAL DATE: the producer idles overnight, so after local midnight the feed still
// holds yesterday's groups until the first dawn run. Given the beach's local date
// (`nowLocalDate`), a FALLBACK group from another date is never used, and neither is
// `latest` when the caller asks (seaweed does: yesterday's seaweed is not today's;
// water has its own night/stale gate). It FAILS CLOSED: a group whose capture date
// cannot be read is rejected too, since it could be anyone's day. With no
// `nowLocalDate` nothing is date-checked. Pure.
import { fmtTime } from "@/lib/format";

export type CamGroupSource = "latest" | "lastSeaweed" | "lastWater" | "morning";

interface GroupLike {
  capturedAtLocal?: string;
  cams?: unknown[];
}

export type CamGroupFeed<G extends GroupLike> = { [K in CamGroupSource]?: G | null };

export interface PickCamGroupOptions {
  /** The beach's local calendar date, YYYY-MM-DD. Unknown -> no date check. */
  nowLocalDate?: string;
  /** Also reject `latest` when it is from another local date. */
  dateGateLatest?: boolean;
}

const CAPTURED_AT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):(\d{2}))$/;

/**
 * THE one parser for a capture stamp (`capturedAtLocal`, as scripts/cam_seaweed.py
 * writes it: "2026-10-13T17:30-04:00", seconds optional, an offset or Z required).
 * Every range is checked (a real calendar date, hour 0-23, minute and second 0-59,
 * offset hour 0-23 and minute 0-59) and `Date.parse` must agree, so "08:99" or
 * "2026-02-31" is rejected rather than half-read. Returns the beach-local date and
 * hour exactly as written, and the instant in ms; undefined for anything else. Pure.
 */
export function parseCapturedAtLocal(
  stamp: string | null | undefined,
): { date: string; hour: number; ms: number } | undefined {
  const m = CAPTURED_AT_RE.exec(stamp ?? "");
  if (!m) return undefined;
  const [y, mo, d, h, mi] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
  const sec = m[6] === undefined ? 0 : Number(m[6]);
  if (mo < 1 || mo > 12 || h > 23 || mi > 59 || sec > 59) return undefined;
  if (m[8] !== undefined && (Number(m[8]) > 23 || Number(m[9]) > 59)) return undefined;
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return undefined;
  const ms = Date.parse(stamp as string);
  if (!Number.isFinite(ms)) return undefined;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, hour: h, ms };
}

/** The beach-local YYYY-MM-DD a group was captured on, or undefined when unknown. */
export function groupLocalDate(group: GroupLike | null | undefined): string | undefined {
  return parseCapturedAtLocal(group?.capturedAtLocal)?.date;
}

/** The first of `sources` (in order) whose group `hasReading` accepts and, when the
 *  local date is known, that was captured today (an undated group is not); null when
 *  none is. */
export function pickCamGroup<G extends GroupLike>(
  feed: CamGroupFeed<G> | null | undefined,
  sources: readonly CamGroupSource[],
  hasReading: (group: G) => boolean,
  opts: PickCamGroupOptions = {},
): { group: G; source: CamGroupSource } | null {
  for (const source of sources) {
    const group = feed?.[source];
    if (!group || !hasReading(group)) continue;
    const gated = source !== "latest" || opts.dateGateLatest === true;
    if (gated && opts.nowLocalDate && groupLocalDate(group) !== opts.nowLocalDate) continue;
    return { group, source };
  }
  return null;
}

/** A read older than this is shown with its time even when it is the newest capture:
 *  after the last daylight tick the feed keeps serving it as `latest` (nothing newer
 *  was gradable), and the card header may be hours later. */
export const STALE_READ_MS = 30 * 60_000;

/**
 * "as of 5:30 PM" for a read that should say when it was taken (beach-local time),
 * else undefined: always for a fallback group (`fallback`), and for any group whose
 * capture is more than STALE_READ_MS before `nowMs`. Undefined when the capture time
 * is missing or unreadable. Pure.
 */
export function camReadAsOf(
  capturedAtLocal: string | undefined,
  tz: string,
  fallback: boolean,
  nowMs?: number,
): string | undefined {
  const capturedMs = parseCapturedAtLocal(capturedAtLocal)?.ms;
  if (capturedMs === undefined || !capturedAtLocal) return undefined;
  const older = nowMs !== undefined && nowMs - capturedMs > STALE_READ_MS;
  if (!fallback && !older) return undefined;
  try {
    return `as of ${fmtTime(capturedAtLocal, tz)}`;
  } catch {
    return undefined; // an unusable timezone: say nothing rather than "Invalid Date"
  }
}

/** The instant at which camReadAsOf starts speaking for a NEWEST capture (it is
 *  already speaking for a fallback group), or undefined when that is not ahead or the
 *  stamp is unreadable. A cached card must expire then, or it keeps the old wording. */
export function camReadAsOfDeadlineMs(capturedAtLocal: string | undefined, fallback: boolean): number | undefined {
  if (fallback) return undefined;
  const ms = parseCapturedAtLocal(capturedAtLocal)?.ms;
  return ms === undefined ? undefined : ms + STALE_READ_MS + 1;
}
