/** A small categorical bar chart shared by the busyness & seaweed history views. */
export interface LevelBar {
  key: string; // unique + stable
  rank: number; // 0..maxRank
  color: string;
  label: string; // x-axis label ("" to omit, e.g. to thin a crowded axis)
  subLabel?: string; // optional second line under the label (e.g. the date)
  tooltip: string;
  highlight?: boolean; // outline + full opacity (e.g. "now" / "today")
  muted?: boolean; // a "no reading yet" placeholder (faint stub, no real value)
}

const W = 720;
const H = 150;
const PL = 30;
const PR = 12;
const PT = 12;
const PB = 30; // room for an optional two-line (weekday + date) x-axis label
const PLOT_W = W - PL - PR;
const PLOT_H = H - PT - PB;
const BASE_Y = PT + PLOT_H;

export function LevelBarChart({
  title,
  subtitle,
  ariaLabel,
  bars,
  maxRank,
  axisLow,
  axisHigh,
}: {
  title: string;
  subtitle: string;
  ariaLabel: string;
  bars: LevelBar[];
  maxRank: number;
  axisLow: string; // bottom y-axis caption (rank 0)
  axisHigh: string; // top y-axis caption (max rank)
}) {
  if (!bars.length) return null;
  const n = bars.length;
  const slot = PLOT_W / n;
  const barW = Math.max(6, Math.min(40, slot * 0.62));
  const xCenter = (i: number) => PL + slot * (i + 0.5);

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-slate-900 dark:text-white">{title}</h2>
      <p className="mb-3 text-xs text-slate-500">{subtitle}</p>
      <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-3 ring-1 ring-slate-900/10 dark:ring-white/10">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ariaLabel}>
          {[axisLow, axisHigh].map((cap, i) => (
            <text
              key={cap + i}
              x={4}
              y={i === 0 ? BASE_Y : PT + 8}
              className="fill-slate-500 dark:fill-slate-400"
              fontSize="9"
            >
              {cap}
            </text>
          ))}
          {bars.map((b, i) => {
            const h = Math.max(4, (b.rank / maxRank) * PLOT_H);
            const x = xCenter(i) - barW / 2;
            return (
              <g key={b.key}>
                <rect
                  x={x}
                  y={BASE_Y - h}
                  width={barW}
                  height={h}
                  rx="2"
                  // Real bars carry a data-driven categorical colour; the muted
                  // "no reading yet" stub uses a theme-aware slate instead.
                  fill={b.muted ? undefined : b.color}
                  className={b.muted ? "fill-slate-400 dark:fill-slate-600" : undefined}
                  opacity={b.muted ? 0.35 : b.highlight ? 1 : 0.85}
                >
                  <title>{b.tooltip}</title>
                </rect>
                {b.highlight && !b.muted ? (
                  <rect
                    x={x - 2}
                    y={BASE_Y - h - 2}
                    width={barW + 4}
                    height={h + 2}
                    rx="3"
                    fill="none"
                    className="stroke-slate-700 dark:stroke-slate-200"
                    strokeWidth="1.5"
                  />
                ) : null}
                {b.label ? (
                  <text
                    x={xCenter(i)}
                    y={b.subLabel ? H - 18 : H - 10}
                    textAnchor="middle"
                    className={b.highlight ? "fill-slate-800 dark:fill-slate-200" : "fill-slate-500"}
                    fontSize="10"
                  >
                    {b.label}
                  </text>
                ) : null}
                {b.subLabel ? (
                  <text
                    x={xCenter(i)}
                    y={H - 6}
                    textAnchor="middle"
                    className={b.highlight ? "fill-slate-800 dark:fill-slate-200" : "fill-slate-500"}
                    fontSize="10"
                  >
                    {b.subLabel}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        {/* The bars only expose their values via SVG hover <title>s, which screen
            readers skip; mirror them in an sr-only list so each hour/day-to-level
            reading is actually announced. */}
        <ul className="sr-only" aria-label={`${ariaLabel} — reading per bar`}>
          {bars.map((b) => (
            <li key={b.key}>{b.tooltip}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
