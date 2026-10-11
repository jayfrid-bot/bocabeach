// Golden-hour windows for the webcam archive (docs/CAM_ARCHIVE_PLAN.md,
// "Golden-hour slots (2026-10-11)").
//
// Around sunrise and sunset the archive keeps a shot about every 10 minutes
// instead of one per hour. This file says WHEN, per beach and local date:
//
//   sunrise window  sunrise - 20 min  to  sunrise + 40 min
//   sunset window   sunset  - 40 min  to  sunset  + 20 min
//
// Each window is half-open: [start, end). The sunrise and sunset instants come
// from `computeSunTimes` (lib/sources/sun.ts), the same NOAA solver the Sun
// panel uses, called with the beach's own local calendar date. When the sun
// does not rise or set that day (polar day or night) the solver gives null and
// the window is null: that day has no golden slots and archives hourly.
//
// Pure: no I/O, no clock reads. Callers pass the instant.

import { localHourParts } from "@/lib/history/archive";
import { shiftLocalDate } from "@/lib/history/summary";
import { computeSunTimes } from "@/lib/sources/sun";

const MIN = 60_000;
const HOUR = 3_600_000;

export const SUNRISE_BEFORE_MIN = 20;
export const SUNRISE_AFTER_MIN = 40;
export const SUNSET_BEFORE_MIN = 40;
export const SUNSET_AFTER_MIN = 20;
/** Slot width inside a golden window. Outside one the slot is the UTC hour. */
export const GOLDEN_SLOT_MS = 10 * MIN;

export type GoldenKind = "sunrise" | "sunset";
export type SlotKind = "hour" | "golden";

/** What the windows need to know about a beach. */
export interface GoldenLoc {
  lat: number;
  lon: number;
  /** IANA zone; the window belongs to the beach-LOCAL calendar date. */
  timezone: string;
}

/** A half-open instant range [startMs, endMs). */
export interface GoldenWindow {
  startMs: number;
  endMs: number;
}

export interface GoldenDay {
  sunrise: GoldenWindow | null;
  sunset: GoldenWindow | null;
}

export interface GoldenHit extends GoldenWindow {
  kind: GoldenKind;
}

/** The ISO form the API sends. */
export interface GoldenWindowIso {
  startUtc: string;
  endUtc: string;
}

export function windowIso(w: GoldenWindow | null): GoldenWindowIso | null {
  return w ? { startUtc: new Date(w.startMs).toISOString(), endUtc: new Date(w.endMs).toISOString() } : null;
}

function window_(eventMs: number | undefined, beforeMin: number, afterMin: number): GoldenWindow | null {
  if (eventMs === undefined || !Number.isFinite(eventMs)) return null;
  return { startMs: eventMs - beforeMin * MIN, endMs: eventMs + afterMin * MIN };
}

/** Both golden windows of one beach-local calendar day (YYYY-MM-DD). */
export function goldenWindowsForDate(loc: GoldenLoc, date: string): GoldenDay {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return { sunrise: null, sunset: null };
  const t = computeSunTimes(loc.lat, loc.lon, Number(m[1]), Number(m[2]), Number(m[3]));
  return {
    sunrise: window_(t.sunrise?.getTime(), SUNRISE_BEFORE_MIN, SUNRISE_AFTER_MIN),
    sunset: window_(t.sunset?.getTime(), SUNSET_BEFORE_MIN, SUNSET_AFTER_MIN),
  };
}

/**
 * Every window of the beach-local dates around `ms` (the day before, the day
 * itself, the day after), so a window that straddles local midnight at high
 * latitude is still found. Sorted by start.
 */
function windowsNear(loc: GoldenLoc, ms: number): GoldenHit[] {
  const { date } = localHourParts(loc.timezone, ms);
  const out: GoldenHit[] = [];
  for (const delta of [-1, 0, 1]) {
    const day = goldenWindowsForDate(loc, shiftLocalDate(date, delta));
    if (day.sunrise) out.push({ kind: "sunrise", ...day.sunrise });
    if (day.sunset) out.push({ kind: "sunset", ...day.sunset });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The golden window containing the instant `ms`, or null. */
export function goldenWindowAt(loc: GoldenLoc, ms: number): GoldenHit | null {
  return windowsNear(loc, ms).find((w) => ms >= w.startMs && ms < w.endMs) ?? null;
}

/** Every golden window that overlaps [fromMs, toMs]. */
export function goldenWindowsOverlapping(loc: GoldenLoc, fromMs: number, toMs: number): GoldenHit[] {
  const seen = new Map<number, GoldenHit>();
  // The range can span a day or two; look around both ends.
  for (const ms of [fromMs, toMs]) {
    for (const w of windowsNear(loc, ms)) {
      if (w.endMs > fromMs && w.startMs <= toMs) seen.set(w.startMs, w);
    }
  }
  return [...seen.values()].sort((a, b) => a.startMs - b.startMs);
}

export interface SlotChoice {
  /** The slot's start instant, UTC ms. */
  slotMs: number;
  slotUtc: string;
  kind: SlotKind;
}

/**
 * The slot rule. A shot whose display time falls inside a golden window goes
 * in a 10-minute slot (display time floored to 10 minutes). Any other shot
 * goes in the UTC-hour slot, as before.
 *
 * Inside a golden window there is no separate "hour slot": the :00 golden slot
 * IS that hour's slot (07:00 is both). The two kinds share only the :00 key and
 * a key holds one row, so a stored hour is never doubled. Outside the windows an
 * hour still holds exactly one shot per cam; inside one it holds up to six.
 */
export function chooseSlot(loc: GoldenLoc | null | undefined, displayMs: number): SlotChoice {
  const golden = loc ? goldenWindowAt(loc, displayMs) !== null : false;
  const size = golden ? GOLDEN_SLOT_MS : HOUR;
  const slotMs = Math.floor(displayMs / size) * size;
  return { slotMs, slotUtc: new Date(slotMs).toISOString(), kind: golden ? "golden" : "hour" };
}

/** Every 10-minute slot start (ISO) of `w` that falls inside [fromMs, toMs]. */
export function goldenSlotsIn(w: GoldenWindow, fromMs: number, toMs: number): string[] {
  const first = Math.floor(Math.max(w.startMs, fromMs) / GOLDEN_SLOT_MS) * GOLDEN_SLOT_MS;
  const last = Math.min(w.endMs - 1, toMs);
  const out: string[] = [];
  for (let s = first; s <= last; s += GOLDEN_SLOT_MS) out.push(new Date(s).toISOString());
  return out;
}
