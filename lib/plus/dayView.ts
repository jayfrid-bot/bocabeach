// Pure helpers for the Plus day view (components/plus/DayViewSheet.tsx and the
// "Pick a day" row in components/plus/HistorySection.tsx). No I/O, no React, no
// clock reads: callers pass the time in. Dates are bare YYYY-MM-DD calendar
// days in the BEACH's timezone, stepped with UTC calendar math, so a DST change
// can never skip or repeat a day.

import { shiftLocalDate, shortMonthDay, weekdayLongOf } from "@/lib/history/summary";
import type { DayHour, DayViewPayload } from "@/lib/history/dayView";

/** 0-23 -> "2 PM". */
export function hour12Label(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h} ${hour < 12 ? "AM" : "PM"}`;
}

/** 0-23 -> "2p": tight enough for a row of 44 px hour buttons. */
export function hour12Compact(hour: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}${hour < 12 ? "a" : "p"}`;
}

/** "EDT" / "EST" for the instant `hourUtc` in IANA zone `tz`. Falls back to "UTC+/-h" when Intl has no short name. */
export function zoneAbbr(tz: string, hourUtc: string): string {
  const at = Date.parse(hourUtc);
  if (!Number.isFinite(at)) return "";
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(at));
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/** 0-23 hour of a clock label like "1:10 AM", or null. */
export function localHourOfLabel(displayAtLocal: string): number | null {
  const m = /^(\d{1,2}):\d{2}\s?(AM|PM)$/i.exec(displayAtLocal.trim());
  if (!m) return null;
  return (Number(m[1]) % 12) + (m[2].toUpperCase() === "PM" ? 12 : 0);
}

/**
 * Local hours that occur twice in this day (the DST fall-back "1 AM"): two
 * different UTC hours share one local hour. Looks at the hour rows and at every
 * camera's shots, since either can be the only one that has both.
 */
export function repeatedLocalHours(day: Pick<DayViewPayload, "hours" | "cams">): Set<number> {
  const seen = new Map<number, Set<string>>();
  const add = (localHour: number | null, hourUtc: string) => {
    if (localHour === null) return;
    const set = seen.get(localHour) ?? new Set<string>();
    set.add(hourUtc);
    seen.set(localHour, set);
  };
  for (const h of day.hours) add(h.localHour, h.hourUtc);
  for (const c of day.cams) for (const f of c.frames) add(localHourOfLabel(f.displayAtLocal), f.hourUtc);
  return new Set([...seen].filter(([, set]) => set.size > 1).map(([h]) => h));
}

/** "1 AM", or "1 AM EDT" when that local hour repeats today. */
export function hourLabelFor(
  hour: { localHour: number; hourUtc: string },
  repeated: Set<number>,
  tz: string,
): string {
  const base = hour12Label(hour.localHour);
  if (!repeated.has(hour.localHour)) return base;
  const z = zoneAbbr(tz, hour.hourUtc);
  return z ? `${base} ${z}` : base;
}

/** The slider's spoken value for a shot: "10 AM", or "1 AM EST" in a repeated hour. */
export function sliderTextFor(
  frame: { hourUtc: string; displayAtLocal: string },
  repeated: Set<number>,
  tz: string,
): string {
  const base = sliderLabel(frame.displayAtLocal);
  const lh = localHourOfLabel(frame.displayAtLocal);
  if (lh === null || !repeated.has(lh)) return base;
  const z = zoneAbbr(tz, frame.hourUtc);
  return z ? `${base} ${z}` : base;
}

/** "Friday, Oct 10" for a YYYY-MM-DD calendar day. */
export function dayTitle(date: string): string {
  return `${weekdayLongOf(date)}, ${shortMonthDay(date)}`;
}

/** Beach-local today as YYYY-MM-DD at `nowMs` in IANA zone `tz`. */
export function todayInZone(tz: string, nowMs: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year").padStart(4, "0")}-${get("month")}-${get("day")}`;
}

/** `date` pulled into [min, max]. A null bound is open. */
export function clampDate(date: string, min: string | null, max: string | null): string {
  if (min && date < min) return min;
  if (max && date > max) return max;
  return date;
}

/** One day earlier (-1) or later (+1), or null when that leaves [min, max]. */
export function stepDate(date: string, delta: -1 | 1, min: string | null, max: string | null): string | null {
  const next = shiftLocalDate(date, delta);
  if (min && next < min) return null;
  if (max && next > max) return null;
  return next;
}

/** True for a well-formed YYYY-MM-DD inside [min, max] (what a date input hands back). */
export function isPickable(date: string, min: string | null, max: string | null): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return clampDate(date, min, max) === date;
}

/** Anything with the slot a shot belongs to. */
interface Slotted {
  hourUtc: string;
}

/**
 * Index of the frame closest in time to `targetHourUtc`, or -1 with no frames.
 * On a tie the EARLIER shot wins, so the answer never depends on array order
 * quirks. `frames` may arrive in any order.
 */
export function nearestFrameIndex(frames: Slotted[], targetHourUtc: string | null): number {
  if (frames.length === 0) return -1;
  const target = targetHourUtc ? Date.parse(targetHourUtc) : NaN;
  if (!Number.isFinite(target)) return 0;
  let best = -1;
  let bestGap = Infinity;
  let bestAt = Infinity;
  frames.forEach((f, i) => {
    const at = Date.parse(f.hourUtc);
    if (!Number.isFinite(at)) return;
    const gap = Math.abs(at - target);
    if (gap < bestGap || (gap === bestGap && at < bestAt)) {
      best = i;
      bestGap = gap;
      bestAt = at;
    }
  });
  return best < 0 ? 0 : best;
}

/** "10:42 AM" -> "10 AM": the slider's spoken value. Anything else comes back unchanged. */
export function sliderLabel(displayAtLocal: string): string {
  const m = /^(\d{1,2}):\d{2}\s?(AM|PM)$/i.exec(displayAtLocal.trim());
  return m ? `${Number(m[1])} ${m[2].toUpperCase()}` : displayAtLocal;
}

/**
 * The line under the picture. Null when the shot is from the selected hour;
 * otherwise "Closest shot: 1:42 PM", so nobody mistakes a shot from another
 * time for the hour they asked about.
 */
export function closestShotText(
  frame: (Slotted & { displayAtLocal: string }) | null,
  selectedHourUtc: string | null,
): string | null {
  if (!frame || !selectedHourUtc) return null;
  return frame.hourUtc === selectedHourUtc ? null : `Closest shot: ${frame.displayAtLocal}`;
}

/** "Oct 11, 2026" for a YYYY-MM-DD day. */
export function longDate(date: string): string {
  return `${shortMonthDay(date)}, ${date.slice(0, 4)}`;
}

/** What a cam with no shot that day says. */
export function emptyCamText(framesStart: string | null): string {
  const base = "No saved camera shots for this day.";
  return framesStart ? `${base} Saving began ${longDate(framesStart)}.` : base;
}

/** Which hour to open on: the day's best score, else the first hour, else the first shot's hour. */
export function defaultHourUtc(payload: DayViewPayload): string | null {
  const best = payload.summary.best;
  if (best) {
    const h = payload.hours.find((x) => x.localHour === best.localHour && x.score === best.score);
    if (h) return h.hourUtc;
  }
  if (payload.hours.length > 0) return payload.hours[0].hourUtc;
  for (const cam of payload.cams) if (cam.frames.length > 0) return cam.frames[0].hourUtc;
  return null;
}

/** The cam to open on: the first one with a shot, else the first. */
export function defaultCamId(payload: DayViewPayload): string | null {
  return (payload.cams.find((c) => c.frames.length > 0) ?? payload.cams[0])?.id ?? null;
}

/** "Best score 92 at 1 PM", or a calm line when the day has no score. */
export function bestLine(payload: DayViewPayload): string {
  const best = payload.summary.best;
  return best ? `Best score ${best.score} at ${hour12Label(best.localHour)}` : "No score for this day";
}

/** One reading for display: value + unit, or an en dash when missing. */
export function readingText(value: number | string | boolean | null | undefined, unit = "", digits = 0): string {
  if (value === null || value === undefined || value === "") return "–";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value.charAt(0).toUpperCase() + value.slice(1);
  if (!Number.isFinite(value)) return "–";
  return `${digits > 0 ? value.toFixed(digits) : Math.round(value)}${unit}`;
}

/** The labelled readings the sheet shows for one hour. Every value is a string, never blank. */
export function readingTiles(hour: DayHour | null): { key: string; label: string; value: string }[] {
  const r = hour?.readings;
  return [
    { key: "air", label: "Air", value: readingText(r?.airF, "°") },
    { key: "water", label: "Water", value: readingText(r?.waterF, "°") },
    { key: "wind", label: "Wind", value: readingText(r?.windMph, " mph") },
    { key: "surf", label: "Surf", value: readingText(r?.surfFt, " ft", 1) },
    { key: "rain", label: "Rain", value: readingText(r?.rainNow) },
    { key: "uv", label: "UV", value: readingText(r?.uv) },
    { key: "sand", label: "Sand", value: readingText(r?.sandF, "°") },
    { key: "flag", label: "Flag", value: readingText(r?.flag) },
    { key: "rip", label: "Rip current", value: readingText(r?.rip) },
    { key: "seaweed", label: "Seaweed", value: readingText(r?.seaweed) },
    { key: "crowd", label: "Crowds", value: readingText(r?.crowdPct, "%") },
  ];
}
