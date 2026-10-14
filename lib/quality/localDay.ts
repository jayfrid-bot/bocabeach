// Local-day edges for a time zone, DST-safe. Pure. Used for "end of the beach's
// day" (a seaweed override lasts that long) and "start of the owner's day" (the
// daily push cap counts from it).

import { localHourParts } from "@/lib/history/archive";

/** The instant (ms) a local calendar date (YYYY-MM-DD) begins in `tz`. */
export function localMidnightMs(tz: string, date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  const asUtc = Date.UTC(y, m - 1, d);
  // First guess with the offset at the date's noon-ish; then re-read the offset
  // at the guess, which settles a DST change that falls between the two.
  const first = asUtc - localHourParts(tz, asUtc).offsetMinutes * 60_000;
  const off = localHourParts(tz, first).offsetMinutes;
  return asUtc - off * 60_000;
}

/** The instant the local day containing `ms` began. */
export function startOfLocalDayMs(tz: string, ms: number): number {
  return localMidnightMs(tz, localHourParts(tz, ms).date);
}

/** The instant the local day containing `ms` ends (= the next day's start). */
export function endOfLocalDayMs(tz: string, ms: number): number {
  const { date } = localHourParts(tz, ms);
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
  return localMidnightMs(tz, next);
}
