// Pure shaping for the Plus "go back to any day" route
// (app/api/history/[slug]/day/route.ts, docs/CAM_ARCHIVE_PLAN.md section 3 and
// R3/R6/R9/R10). No I/O, no clock reads: the route reads D1, signs the links,
// and hands plain rows to the functions here. The types are the response
// contract; the client (lib/plus/api.ts, components/plus/DayViewSheet.tsx)
// imports them type-only.

import type { BeachHourlyRow } from "@/lib/history/types";
import type { DaySummary, HistoryVersions } from "@/lib/history/summary";

/** What the day view shows for one hour. A value the archive never kept is null. */
export interface DayReadings {
  airF: number | null;
  waterF: number | null;
  windMph: number | null;
  /** Wind direction is not archived yet; always null for now. */
  windDir: number | null;
  /** Estimated SURF height (surf_ft), never the raw wave height (wave_ft). */
  surfFt: number | null;
  rainNow: boolean | null;
  uv: number | null;
  sandF: number | null;
  /** The most severe lifeguard flag that flew that hour ("green", "yellow", ...). */
  flag: string | null;
  /** Rip current level word ("low", "moderate", "high", ...). */
  rip: string | null;
  /** Seaweed level word ("low", ...). */
  seaweed: string | null;
  crowdPct: number | null;
}

export interface DayHour {
  /** The key. A DST fall-back day has two rows that both read as local hour 1. */
  hourUtc: string;
  localHour: number;
  utcOffsetMinutes: number;
  score: number | null;
  rating: string | null;
  engineVersion: string;
  readings: DayReadings;
}

export interface DayFrame {
  /** The frame's slot: its display time floored to the UTC hour (same key shape as `DayHour.hourUtc`). */
  hourUtc: string;
  /** Beach-local clock time of the shot, e.g. "10:42 AM". */
  displayAtLocal: string;
  /** Credit line stored on this frame's own row. */
  attribution: string | null;
  /** Signed, 15-minute link to GET /api/cam-frames/img. */
  url: string;
}

export interface DayCam {
  id: string;
  name: string;
  /** Credit line of this cam's newest shot that day, or null with no shot. */
  attribution: string | null;
  frames: DayFrame[];
}

export interface DayViewPayload {
  date: string;
  timezone: string;
  hours: DayHour[];
  summary: DaySummary;
  versions: HistoryVersions;
  cams: DayCam[];
  /** First beach-local date the hourly archive has a row for (picker minimum). */
  archiveStart: string | null;
  /** First beach-local date that has a saved camera shot, for the empty-state line. */
  framesStart: string | null;
}

/** The slice of a `cam_frames` row the day view reads. */
export interface DayFrameRow {
  cam_id: string;
  slot_utc: string;
  local_hour: number;
  local_minute: number;
  r2_key: string;
  attribution: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/** `extra_json` parsed defensively: anything that is not a JSON object is {}. */
export function parseExtra(json: string | null): Record<string, unknown> {
  if (!json) return {};
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function block(extra: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = extra[key];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Least to most severe. "unknown" is never reported as a flag. */
const FLAG_SEVERITY = ["green", "yellow", "purple", "red", "double-red"] as const;

/** The most severe known flag in a posted-flags list, or null. */
export function mostSevereFlag(colors: unknown): string | null {
  if (!Array.isArray(colors)) return null;
  let best = -1;
  for (const c of colors) {
    const i = FLAG_SEVERITY.indexOf(c as (typeof FLAG_SEVERITY)[number]);
    if (i > best) best = i;
  }
  return best >= 0 ? FLAG_SEVERITY[best] : null;
}

/** One hour's readings from the row's columns plus its `extra_json`. */
export function readingsOf(row: BeachHourlyRow): DayReadings {
  const extra = parseExtra(row.extra_json);
  return {
    airF: num(row.air_temp_f),
    waterF: num(row.water_temp_f),
    windMph: num(row.wind_mph),
    windDir: null,
    surfFt: num(row.surf_ft),
    rainNow: row.rain_now === 1 ? true : row.rain_now === 0 ? false : null,
    uv: num(row.uv),
    sandF: num(row.sand_temp_f) ?? num(block(extra, "sand").tempF),
    flag: mostSevereFlag(block(extra, "flags").colors),
    rip: str(block(extra, "rip").level),
    seaweed: str(row.seaweed_level),
    crowdPct: num(row.crowd_pct),
  };
}

/** The day's rows as hour entries, ordered by `hour_utc`. */
export function shapeHours(rows: BeachHourlyRow[]): DayHour[] {
  return [...rows]
    .sort((a, b) => (a.hour_utc < b.hour_utc ? -1 : a.hour_utc > b.hour_utc ? 1 : 0))
    .map((r) => ({
      hourUtc: r.hour_utc,
      localHour: r.local_hour,
      utcOffsetMinutes: r.utc_offset_minutes,
      score: num(r.score),
      rating: str(r.rating),
      engineVersion: r.engine_version,
      readings: readingsOf(r),
    }));
}

/** 0-23 and 0-59 -> "10:42 AM". Built from the row's own local parts, so DST needs no math. */
export function clockLabel(hour: number, minute: number): string {
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

/**
 * Group ready frame rows into the archived cams of one beach. `cams` is the
 * manifest (only cams still archived, in config order): a row for any other
 * cam is dropped, which is how `archive: false` hides a cam at once. A cam with
 * no row that day stays in the list with `frames: []`. `urlFor` signs a key;
 * a row it returns null for (a malformed key) is skipped.
 */
export function shapeCams(
  cams: { camId: string; name: string }[],
  rows: DayFrameRow[],
  urlFor: (key: string) => string | null,
): DayCam[] {
  return cams.map((cam) => {
    const frames: DayFrame[] = [];
    const mine = rows
      .filter((r) => r.cam_id === cam.camId)
      .sort((a, b) => (a.slot_utc < b.slot_utc ? -1 : a.slot_utc > b.slot_utc ? 1 : 0));
    for (const r of mine) {
      const url = urlFor(r.r2_key);
      if (!url) continue;
      frames.push({
        hourUtc: r.slot_utc,
        displayAtLocal: clockLabel(r.local_hour, r.local_minute),
        attribution: r.attribution ?? null,
        url,
      });
    }
    const newest = frames.length ? frames[frames.length - 1] : null;
    return { id: cam.camId, name: cam.name, attribution: newest?.attribution ?? null, frames };
  });
}
