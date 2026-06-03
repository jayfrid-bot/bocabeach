import type { HourlyScore } from "@/lib/types";
import { fmtTime, scoreColor } from "@/lib/format";
import { degToCardinal } from "@/lib/util";

// viewBox geometry (units ≈ px at the common render width).
const W = 720;
const H = 200;
const PL = 12; // left / right padding
const PR = 12;
const PT = 18; // top (headroom for the "now" label)
const PB = 30; // bottom (hour labels)
const PLOT_W = W - PL - PR;
const PLOT_H = H - PT - PB;
const BASE_Y = PT + PLOT_H; // y of score 0

const yFor = (score: number) =>
  PT + (1 - Math.max(0, Math.min(100, score)) / 100) * PLOT_H;

/**
 * Beach Day score across today's daylight hours as a line graph that rises and
 * falls with the score, with a "now" marker placed at the current local time,
 * and a per-hour wind (speed + direction) strip beneath it.
 */
export function HourlyScoreGraph({
  hours,
  tz,
}: {
  hours: HourlyScore[];
  tz: string;
}) {
  if (hours.length === 0) return null;

  const pts = hours.map((h) => ({ t: new Date(h.time).getTime(), s: h.score, h }));
  const t0 = pts[0].t;
  const tN = pts[pts.length - 1].t;
  const span = Math.max(tN - t0, 1);
  const xFor = (t: number) =>
    pts.length === 1 ? PL + PLOT_W / 2 : PL + ((t - t0) / span) * PLOT_W;

  const xy = pts.map((p) => ({ ...p, x: xFor(p.t), y: yFor(p.s) }));
  const line = xy.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const area =
    `M${xy[0].x.toFixed(1)} ${BASE_Y} ` +
    xy.map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") +
    ` L${xy[xy.length - 1].x.toFixed(1)} ${BASE_Y} Z`;

  // "Now" marker — only while the current moment falls within (or just around)
  // today's plotted daylight window. Score is interpolated between hours.
  const now = Date.now();
  const showNow = now >= t0 - 36e5 && now <= tN + 36e5;
  const scoreAt = (ms: number) => {
    if (ms <= xy[0].t) return xy[0].s;
    if (ms >= xy[xy.length - 1].t) return xy[xy.length - 1].s;
    for (let i = 0; i < xy.length - 1; i++) {
      if (ms <= xy[i + 1].t) {
        const f = (ms - xy[i].t) / (xy[i + 1].t - xy[i].t);
        return xy[i].s + f * (xy[i + 1].s - xy[i].s);
      }
    }
    return xy[xy.length - 1].s;
  };
  const nowClamped = Math.max(t0, Math.min(tN, now));
  const nowX = xFor(nowClamped);
  const nowScore = Math.round(scoreAt(nowClamped));
  const nowAnchor = nowX > W - 120 ? "end" : nowX < 120 ? "start" : "middle";

  // Label ~6 hours across the axis (always include the last).
  const step = Math.max(1, Math.ceil(xy.length / 6));
  const labelAt = (i: number) => i % step === 0 || i === xy.length - 1;

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-white">Today&apos;s hourly score</h2>
      <p className="mb-3 text-xs text-slate-500">
        Beach Day score through the day — sunrise to sunset. The marker is the
        current local time.
      </p>

      <div className="rounded-2xl bg-slate-900/70 p-3 ring-1 ring-white/10">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Hourly Beach Day score">
          <defs>
            <linearGradient id="hsg-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#38bdf8" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* horizontal gridlines + scale labels at 0 / 50 / 100 */}
          {[0, 50, 100].map((g) => (
            <g key={g}>
              <line
                x1={PL}
                x2={W - PR}
                y1={yFor(g)}
                y2={yFor(g)}
                stroke="#334155"
                strokeWidth="1"
                strokeDasharray={g === 0 ? undefined : "3 4"}
              />
              <text x={PL} y={yFor(g) - 3} fill="#475569" fontSize="10">
                {g}
              </text>
            </g>
          ))}

          {/* "now" marker */}
          {showNow ? (
            <g>
              <line
                x1={nowX}
                x2={nowX}
                y1={PT - 6}
                y2={BASE_Y}
                stroke="#e2e8f0"
                strokeWidth="1.5"
                strokeDasharray="2 3"
              />
              <text
                x={nowX}
                y={PT - 9}
                textAnchor={nowAnchor}
                fill="#e2e8f0"
                fontSize="11"
                fontWeight="600"
              >
                Now · {fmtTime(new Date(now).toISOString(), tz)} · {nowScore}
              </text>
            </g>
          ) : null}

          <path d={area} fill="url(#hsg-fill)" />
          <path d={line} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinejoin="round" />

          {/* per-hour dots colored by score */}
          {xy.map((p) => (
            <circle key={p.t} cx={p.x} cy={p.y} r="3.2" fill={scoreColor(p.s)} />
          ))}

          {/* current-time dot on the line */}
          {showNow ? (
            <circle
              cx={nowX}
              cy={yFor(nowScore)}
              r="5"
              fill={scoreColor(nowScore)}
              stroke="#0f172a"
              strokeWidth="2"
            />
          ) : null}

          {/* hour labels */}
          {xy.map((p, i) =>
            labelAt(i) ? (
              <text
                key={`l-${p.t}`}
                x={p.x}
                y={H - 10}
                textAnchor="middle"
                fill="#64748b"
                fontSize="10"
              >
                {fmtTime(p.h.time, tz).replace(":00", "")}
              </text>
            ) : null,
          )}
        </svg>

        {/* per-hour wind speed + direction */}
        <div className="mt-2 flex gap-1 overflow-x-auto border-t border-white/5 pt-2">
          {hours.map((h) => {
            const known = typeof h.windDirDeg === "number";
            return (
              <div key={h.time} className="w-12 shrink-0 text-center">
                <div className="text-[10px] uppercase text-slate-500">
                  {fmtTime(h.time, tz).replace(":00", "")}
                </div>
                <div className="my-0.5 text-sm" aria-hidden>
                  {h.emoji || "•"}
                </div>
                <svg
                  viewBox="0 0 24 24"
                  className="mx-auto h-4 w-4"
                  aria-label={
                    known ? `wind from ${degToCardinal(h.windDirDeg as number)}` : "wind direction n/a"
                  }
                >
                  {known ? (
                    <g transform={`rotate(${(h.windDirDeg as number) + 180} 12 12)`}>
                      <path d="M12 3 L16.5 19 L12 15.5 L7.5 19 Z" fill="#38bdf8" />
                    </g>
                  ) : (
                    <text x="12" y="16" textAnchor="middle" fill="#475569" fontSize="12">
                      –
                    </text>
                  )}
                </svg>
                <div className="text-[11px] font-medium text-slate-300">
                  {typeof h.windSpeedMph === "number" ? h.windSpeedMph : "–"}
                </div>
                <div className="text-[9px] text-slate-500">
                  {known ? degToCardinal(h.windDirDeg as number) : ""}
                  {h.raining ? " 💧" : ""}
                </div>
              </div>
            );
          })}
        </div>
        <p className="mt-1 text-center text-[10px] text-slate-600">
          wind mph · arrow points the way it blows
        </p>
      </div>
    </section>
  );
}
