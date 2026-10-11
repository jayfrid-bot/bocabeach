// The three clocks of a stored webcam frame (docs/CAM_ARCHIVE_PLAN.md R3).
//
//   received_at  the server clock at ingest. Retention and audit use it.
//   frame_at     the source's own capture time, when the capture script knew
//                it and it is believable. Otherwise null.
//   display_at   frame_at ?? received_at. The user sees this time.
//
// slot = display_at floored to the UTC hour (the beach_hourly hour_utc shape).
// Local date, hour and offset come from `localHourParts`, the helper
// beach_hourly uses, so history and cams always agree on "which hour".
// A client-sent time never drives the throttle or retention: only the server
// clock does, and frame_at is only ever shown, never trusted for either.

import { hourUtcOf, localHourParts } from "@/lib/history/archive";

/** A frame stamped further ahead than this is a bad clock: drop its time. */
export const MAX_FRAME_FUTURE_MS = 5 * 60_000;
/** A frame older than this is stale: drop its time (it is shown at received time). */
export const MAX_FRAME_AGE_MS = 3 * 3_600_000;

/** ISO-8601 instant with a zone designator, e.g. 2026-10-11T14:05:09Z or ...+00:00. */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validate a source capture time. Returns the normalized ISO string (UTC), or
 * null when it is missing, malformed, more than 5 minutes ahead of `nowMs`,
 * or more than 3 hours behind it.
 */
export function validateFrameAt(raw: unknown, nowMs: number): string | null {
  if (typeof raw !== "string" || raw.length > 40 || !ISO_INSTANT_RE.test(raw)) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  if (ms - nowMs > MAX_FRAME_FUTURE_MS) return null;
  if (nowMs - ms > MAX_FRAME_AGE_MS) return null;
  return new Date(ms).toISOString();
}

export interface FrameClocks {
  receivedAtUtc: string;
  frameAtUtc: string | null;
  displayAtUtc: string;
  /** display time floored to the UTC hour. */
  slotUtc: string;
  localDate: string;
  localHour: number;
  localMinute: number;
  utcOffsetMinutes: number;
  timezone: string;
}

/**
 * All clocks for one ingest. `nowMs` is the server clock. `frameAtRaw` is the
 * client-sent `frameAt` query value, if any. `timezone` is the beach's IANA zone.
 */
export function frameClocks(args: { nowMs: number; frameAtRaw: unknown; timezone: string }): FrameClocks {
  const { nowMs, frameAtRaw, timezone } = args;
  const receivedAtUtc = new Date(nowMs).toISOString();
  const frameAtUtc = validateFrameAt(frameAtRaw, nowMs);
  const displayAtUtc = frameAtUtc ?? receivedAtUtc;
  const displayMs = Date.parse(displayAtUtc);
  const { date, hour, offsetMinutes } = localHourParts(timezone, displayMs);
  // Local minute: shift the instant by the zone offset, then read the UTC minute.
  // Exact for every zone, whole-hour offset or not.
  const localMinute = ((Math.floor(displayMs / 60_000) + offsetMinutes) % 60 + 60) % 60;
  return {
    receivedAtUtc,
    frameAtUtc,
    displayAtUtc,
    slotUtc: hourUtcOf(displayMs),
    localDate: date,
    localHour: hour,
    localMinute,
    utcOffsetMinutes: offsetMinutes,
    timezone,
  };
}
