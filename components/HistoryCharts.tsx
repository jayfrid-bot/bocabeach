import type {
  BusynessByDay,
  BusynessByHour,
  SargassumByDay,
  SargassumByHour,
} from "@/lib/types";
import { LevelBarChart, type LevelBar } from "@/components/LevelBarChart";

// Shared palettes (clean/quiet = green … heavy/packed = rose).
const BUSY_COLOR: Record<string, string> = {
  empty: "#475569",
  quiet: "#34d399",
  moderate: "#a3e635",
  busy: "#fbbf24",
  packed: "#fb7185",
};
const BUSY_RANK: Record<string, number> = {
  empty: 0,
  quiet: 1,
  moderate: 2,
  busy: 3,
  packed: 4,
};
const SEA_COLOR: Record<string, string> = {
  none: "#34d399",
  low: "#a3e635",
  moderate: "#fbbf24",
  high: "#fb7185",
};
const SEA_RANK: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3 };

const MAX_DAYS = 21; // keep the by-day axis readable

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** Current local hour at the beach (for the "now" highlight). */
function nowHour(tz: string): number {
  return (
    Number(
      new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(
        new Date(),
      ),
    ) % 24
  );
}
/** Today's local date (YYYY-MM-DD) at the beach (for the "today" highlight). */
function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// The dates are already local YYYY-MM-DD; render them tz-agnostically off UTC.
function asDate(date: string): Date | null {
  const [y, m, d] = date.split("-").map(Number);
  return y && m && d ? new Date(Date.UTC(y, m - 1, d)) : null;
}
const fmtWeekday = (date: string) =>
  asDate(date)?.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" }) ?? "";
const fmtMD = (date: string) => {
  const [, m, d] = date.split("-").map(Number);
  return m && d ? `${m}/${d}` : date;
};
const fmtDayLong = (date: string) =>
  asDate(date)?.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }) ?? date;

/**
 * Build the by-hour axis across the daylight window: start at sunrise, end at
 * sunset, and emit a placeholder (no `level`) for any hour without a reading yet
 * so the axis truly begins at sunrise even before the dawn cams have populated.
 * Falls back to the data's own min..max when sun times are unknown.
 */
function spanDaylight<T extends { hour: number }>(
  rows: T[],
  lo?: number,
  hi?: number,
): (T | { hour: number })[] {
  if (!rows.length) return [];
  const present = rows.map((r) => r.hour);
  const start = lo ?? Math.min(...present);
  const end = hi ?? Math.max(...present);
  if (end < start) return rows;
  const byHour = new Map(rows.map((r) => [r.hour, r]));
  const out: (T | { hour: number })[] = [];
  for (let h = start; h <= end; h++) out.push(byHour.get(h) ?? { hour: h });
  return out;
}

interface HourProps {
  tz: string;
  /** Local hour of sunrise / sunset; the by-hour axis is bounded to this window. */
  sunriseHour?: number;
  sunsetHour?: number;
}

export function BusynessByHourChart({
  byHour,
  tz,
  sunriseHour,
  sunsetHour,
}: { byHour: BusynessByHour[] } & HourProps) {
  const now = nowHour(tz);
  const hours = spanDaylight(byHour, sunriseHour, sunsetHour);
  if (!hours.length) return null;
  const bars: LevelBar[] = hours.map((b) => {
    if (!("level" in b) || !(b.level in BUSY_RANK)) {
      return {
        key: String(b.hour),
        rank: 0,
        color: "#475569",
        muted: true,
        label: hourLabel(b.hour),
        tooltip: `${hourLabel(b.hour)}: no reading yet`,
      };
    }
    return {
      key: String(b.hour),
      rank: BUSY_RANK[b.level] ?? 0,
      color: BUSY_COLOR[b.level] ?? "#475569",
      label: hourLabel(b.hour),
      highlight: b.hour === now,
      tooltip: `${hourLabel(b.hour)}: ${b.level}${b.people != null ? ` (~${b.people})` : ""}`,
    };
  });
  return (
    <LevelBarChart
      title="Beach busyness by time of day"
      subtitle="Typical crowd by daylight hour (builds up over time). Outlined bar = now."
      ariaLabel="Busyness by hour"
      bars={bars}
      maxRank={4}
      axisLow="empty"
      axisHigh="packed"
    />
  );
}

export function SeaweedByHourChart({
  byHour,
  tz,
  sunriseHour,
  sunsetHour,
}: { byHour: SargassumByHour[] } & HourProps) {
  const now = nowHour(tz);
  const hours = spanDaylight(byHour, sunriseHour, sunsetHour);
  if (!hours.length) return null;
  const bars: LevelBar[] = hours.map((b) => {
    if (!("level" in b) || !(b.level in SEA_RANK)) {
      return {
        key: String(b.hour),
        rank: 0,
        color: "#475569",
        muted: true,
        label: hourLabel(b.hour),
        tooltip: `${hourLabel(b.hour)}: no reading yet`,
      };
    }
    return {
      key: String(b.hour),
      rank: SEA_RANK[b.level] ?? 0,
      color: SEA_COLOR[b.level] ?? "#475569",
      label: hourLabel(b.hour),
      highlight: b.hour === now,
      tooltip: `${hourLabel(b.hour)}: ${b.level}`,
    };
  });
  return (
    <LevelBarChart
      title="Seaweed by time of day"
      subtitle="Typical seaweed by daylight hour — heaviest at dawn, eased after the morning beach-cleaning."
      ariaLabel="Seaweed by hour"
      bars={bars}
      maxRank={3}
      axisLow="none"
      axisHigh="high"
    />
  );
}

/**
 * Shared bar-builder for the by-day charts: bar HEIGHT is the day's average level
 * (continuous `avg` on the 0..maxRank scale) and COLOUR is that average's band,
 * so the two by-day charts read consistently.
 */
function avgDayBars<T extends { date: string; avg: number; level: string; samples: number }>(
  byDay: T[],
  tz: string,
  color: Record<string, string>,
  tip: (b: T) => string,
): LevelBar[] {
  const today = todayLocal(tz);
  const days = byDay.slice(-MAX_DAYS);
  const every = days.length > 16 ? 3 : days.length > 10 ? 2 : 1;
  return days.map((b, i) => {
    const show = i % every === 0 || b.date === today;
    return {
      key: b.date,
      rank: b.avg,
      color: color[b.level] ?? "#475569",
      label: show ? fmtWeekday(b.date) : "",
      subLabel: show ? fmtMD(b.date) : "",
      highlight: b.date === today,
      tooltip: `${fmtDayLong(b.date)}: ${tip(b)}`,
    };
  });
}

const reads = (n: number) => `${n} read${n === 1 ? "" : "s"}`;

export function BusynessByDayChart({ byDay, tz }: { byDay: BusynessByDay[]; tz: string }) {
  const bars = avgDayBars(
    byDay,
    tz,
    BUSY_COLOR,
    (b) => `${cap(b.level)} avg${b.people != null ? ` (~${b.people})` : ""} · ${reads(b.samples)}`,
  );
  return (
    <LevelBarChart
      title="Beach busyness by day"
      subtitle="Average crowd each day across the cam reads. Outlined bar = today."
      ariaLabel="Busyness by day"
      bars={bars}
      maxRank={4}
      axisLow="empty"
      axisHigh="packed"
    />
  );
}

export function SeaweedByDayChart({ byDay, tz }: { byDay: SargassumByDay[]; tz: string }) {
  const bars = avgDayBars(
    byDay,
    tz,
    SEA_COLOR,
    (b) => `${cap(b.level)} avg (worst ${cap(b.worst)}) · ${reads(b.samples)}`,
  );
  return (
    <LevelBarChart
      title="Seaweed by day"
      subtitle="Average seaweed each day across the cam reads. Outlined bar = today."
      ariaLabel="Seaweed by day"
      bars={bars}
      maxRank={3}
      axisLow="none"
      axisHigh="high"
    />
  );
}
