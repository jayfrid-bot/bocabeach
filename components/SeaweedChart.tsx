import type { SargassumByDay } from "@/lib/types";

// Clean → heavy: green (good) through rose (bad), matching the busyness palette.
const LEVEL_COLOR: Record<string, string> = {
  none: "#34d399",
  low: "#a3e635",
  moderate: "#fbbf24",
  high: "#fb7185",
};
const RANK: Record<string, number> = { none: 0, low: 1, moderate: 2, high: 3 };
const MAX_RANK = 3;

const W = 720;
const H = 150;
const PL = 30;
const PR = 12;
const PT = 12;
const PB = 24;
const PLOT_W = W - PL - PR;
const PLOT_H = H - PT - PB;
const BASE_Y = PT + PLOT_H;

// Show at most the last few weeks so the bars/labels stay readable.
const MAX_DAYS = 21;

/** Today's local calendar date (YYYY-MM-DD) at the beach. */
function todayLocal(tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** "2026-06-07" → "Jun 7" (rendered tz-agnostically; the date is already local). */
function fmtDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const dayNum = (date: string) => date.slice(8, 10).replace(/^0/, "");

/** Recent daily seaweed levels, learned from the rolling cam history. */
export function SeaweedChart({
  byDay,
  tz,
}: {
  byDay: SargassumByDay[];
  tz: string;
}) {
  const days = byDay.filter((d) => d.level in RANK).slice(-MAX_DAYS);
  if (!days.length) return null;

  const today = todayLocal(tz);
  const n = days.length;
  const slot = PLOT_W / n;
  const barW = Math.max(6, Math.min(36, slot * 0.62));
  const xCenter = (i: number) => PL + slot * (i + 0.5);
  // Thin out x-labels when there are many days so they don't overlap.
  const labelEvery = n > 16 ? 3 : n > 10 ? 2 : 1;

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-white">Seaweed by day</h2>
      <p className="mb-3 text-xs text-slate-500">
        Daily sargassum seen on the beach cams (morning, pre-cleaning when
        available). Outlined bar = today.
      </p>
      <div className="rounded-2xl bg-slate-900/70 p-3 ring-1 ring-white/10">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label="Seaweed by day"
        >
          {["none", "high"].map((lvl, i) => (
            <text key={lvl} x={4} y={i === 0 ? BASE_Y : PT + 8} fill="#475569" fontSize="9">
              {lvl}
            </text>
          ))}
          {days.map((b, i) => {
            const rank = RANK[b.level] ?? 0;
            const h = Math.max(4, (rank / MAX_RANK) * PLOT_H);
            const x = xCenter(i) - barW / 2;
            const isToday = b.date === today;
            const showLabel = i % labelEvery === 0 || isToday;
            return (
              <g key={b.date}>
                <rect
                  x={x}
                  y={BASE_Y - h}
                  width={barW}
                  height={h}
                  rx="2"
                  fill={LEVEL_COLOR[b.level] ?? "#475569"}
                  opacity={isToday ? 1 : 0.85}
                >
                  <title>
                    {fmtDay(b.date)}: {b.level}
                    {b.isMorning ? " (AM)" : ""}
                  </title>
                </rect>
                {isToday ? (
                  <rect
                    x={x - 2}
                    y={BASE_Y - h - 2}
                    width={barW + 4}
                    height={h + 2}
                    rx="3"
                    fill="none"
                    stroke="#e2e8f0"
                    strokeWidth="1.5"
                  />
                ) : null}
                {showLabel ? (
                  <text
                    x={xCenter(i)}
                    y={H - 8}
                    textAnchor="middle"
                    fill={isToday ? "#e2e8f0" : "#64748b"}
                    fontSize="10"
                  >
                    {dayNum(b.date)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
