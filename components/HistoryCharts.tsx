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
const dayNum = (date: string) => date.slice(8, 10).replace(/^0/, "");

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
/** "2026-06-07" → "Jun 7" (the date is already local; render tz-agnostically). */
function fmtDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function BusynessByHourChart({ byHour, tz }: { byHour: BusynessByHour[]; tz: string }) {
  const now = nowHour(tz);
  const bars: LevelBar[] = byHour.map((b) => ({
    key: String(b.hour),
    rank: BUSY_RANK[b.level] ?? 0,
    color: BUSY_COLOR[b.level] ?? "#475569",
    label: hourLabel(b.hour),
    highlight: b.hour === now,
    tooltip: `${hourLabel(b.hour)}: ${b.level}${b.people != null ? ` (~${b.people})` : ""}`,
  }));
  return (
    <LevelBarChart
      title="Beach busyness by time of day"
      subtitle="Typical crowd from the cams (builds up over time). Outlined bar = now."
      ariaLabel="Busyness by hour"
      bars={bars}
      maxRank={4}
      axisLow="empty"
      axisHigh="packed"
    />
  );
}

export function BusynessByDayChart({ byDay, tz }: { byDay: BusynessByDay[]; tz: string }) {
  const today = todayLocal(tz);
  const days = byDay.slice(-MAX_DAYS);
  const every = days.length > 16 ? 3 : days.length > 10 ? 2 : 1;
  const bars: LevelBar[] = days.map((b, i) => ({
    key: b.date,
    rank: BUSY_RANK[b.level] ?? 0,
    color: BUSY_COLOR[b.level] ?? "#475569",
    label: i % every === 0 || b.date === today ? dayNum(b.date) : "",
    highlight: b.date === today,
    tooltip: `${fmtDay(b.date)}: ${cap(b.level)}${b.people != null ? ` (~${b.people})` : ""}`,
  }));
  return (
    <LevelBarChart
      title="Beach busyness by day"
      subtitle="Busiest the beach got each day. Outlined bar = today."
      ariaLabel="Busyness by day"
      bars={bars}
      maxRank={4}
      axisLow="empty"
      axisHigh="packed"
    />
  );
}

export function SeaweedByHourChart({ byHour, tz }: { byHour: SargassumByHour[]; tz: string }) {
  const now = nowHour(tz);
  const bars: LevelBar[] = byHour.map((b) => ({
    key: String(b.hour),
    rank: SEA_RANK[b.level] ?? 0,
    color: SEA_COLOR[b.level] ?? "#475569",
    label: hourLabel(b.hour),
    highlight: b.hour === now,
    tooltip: `${hourLabel(b.hour)}: ${b.level}`,
  }));
  return (
    <LevelBarChart
      title="Seaweed by time of day"
      subtitle="Typical sargassum by hour — heaviest at dawn, eased after the morning beach-cleaning."
      ariaLabel="Seaweed by hour"
      bars={bars}
      maxRank={3}
      axisLow="none"
      axisHigh="high"
    />
  );
}

export function SeaweedByDayChart({ byDay, tz }: { byDay: SargassumByDay[]; tz: string }) {
  const today = todayLocal(tz);
  const days = byDay.slice(-MAX_DAYS);
  const every = days.length > 16 ? 3 : days.length > 10 ? 2 : 1;
  const bars: LevelBar[] = days.map((b, i) => ({
    key: b.date,
    rank: SEA_RANK[b.level] ?? 0,
    color: SEA_COLOR[b.level] ?? "#475569",
    label: i % every === 0 || b.date === today ? dayNum(b.date) : "",
    highlight: b.date === today,
    tooltip: `${fmtDay(b.date)}: ${b.level}`,
  }));
  return (
    <LevelBarChart
      title="Seaweed by day"
      subtitle="Worst sargassum seen on the cams each day. Outlined bar = today."
      ariaLabel="Seaweed by day"
      bars={bars}
      maxRank={3}
      axisLow="none"
      axisHigh="high"
    />
  );
}
