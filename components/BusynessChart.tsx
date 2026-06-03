import type { BusynessByHour } from "@/lib/types";

const LEVEL_COLOR: Record<string, string> = {
  empty: "#475569",
  quiet: "#34d399",
  moderate: "#a3e635",
  busy: "#fbbf24",
  packed: "#fb7185",
};
const RANK: Record<string, number> = {
  empty: 0,
  quiet: 1,
  moderate: 2,
  busy: 3,
  packed: 4,
};

const W = 720;
const H = 150;
const PL = 30;
const PR = 12;
const PT = 12;
const PB = 24;
const PLOT_W = W - PL - PR;
const PLOT_H = H - PT - PB;
const BASE_Y = PT + PLOT_H;

const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "a" : "p"}`;

/** Typical beach busyness by local hour, learned from the rolling cam history. */
export function BusynessChart({
  byHour,
  tz,
}: {
  byHour: BusynessByHour[];
  tz: string;
}) {
  if (!byHour.length) return null;

  const hours = byHour.map((b) => b.hour);
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours);
  const span = Math.max(maxH - minH, 1);
  const xFor = (h: number) =>
    byHour.length === 1 ? PL + PLOT_W / 2 : PL + ((h - minH) / span) * PLOT_W;
  const barW = Math.max(6, Math.min(40, (PLOT_W / (span + 1)) * 0.6));

  const nowHour =
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        hour12: false,
      }).format(new Date()),
    ) % 24;

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-white">
        Beach busyness by time of day
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        Typical crowd from the beach cams (builds up over time). Outlined bar = now.
      </p>
      <div className="rounded-2xl bg-slate-900/70 p-3 ring-1 ring-white/10">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Busyness by hour">
          {["empty", "packed"].map((lvl, i) => (
            <text
              key={lvl}
              x={4}
              y={i === 0 ? BASE_Y : PT + 8}
              fill="#475569"
              fontSize="9"
            >
              {lvl}
            </text>
          ))}
          {byHour.map((b) => {
            const rank = RANK[b.level] ?? 0;
            const h = Math.max(4, (rank / 4) * PLOT_H);
            const x = xFor(b.hour) - barW / 2;
            const isNow = b.hour === nowHour;
            return (
              <g key={b.hour}>
                <rect
                  x={x}
                  y={BASE_Y - h}
                  width={barW}
                  height={h}
                  rx="2"
                  fill={LEVEL_COLOR[b.level] ?? "#475569"}
                  opacity={isNow ? 1 : 0.85}
                >
                  <title>
                    {hourLabel(b.hour)}: {b.level}
                    {b.people != null ? ` (~${b.people})` : ""}
                  </title>
                </rect>
                {isNow ? (
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
                <text
                  x={xFor(b.hour)}
                  y={H - 8}
                  textAnchor="middle"
                  fill={isNow ? "#e2e8f0" : "#64748b"}
                  fontSize="10"
                >
                  {hourLabel(b.hour)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
