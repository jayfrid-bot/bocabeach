import type { DayWindow } from "@/lib/types";
import { fmtTime, scoreColor } from "@/lib/format";

/**
 * "Best beach times" forecast: one tile per upcoming day showing the best
 * window to go (by Beach Day score) and that day's peak score. The hour-to-hour
 * weather (sun, wind, rain, heat, UV) is a real per-day forecast; slower-moving
 * inputs (water temp, surf, advisories) carry from now — so it's an estimate.
 */
export function BestTimesStrip({ days, tz }: { days: DayWindow[]; tz: string }) {
  // Need at least tomorrow to be worth a multi-day strip.
  if (days.length < 2) return null;

  return (
    <section>
      <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Best beach times</h2>
      <p className="mb-3 mt-1 text-xs text-slate-500">
        The best window to go each day, by Beach Day score. A forecast estimate —
        conditions can change.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {days.map((d) => (
          <div
            key={d.date}
            className="rounded-2xl bg-white/80 p-3 text-center ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10"
          >
            <div className="text-xs font-medium uppercase text-slate-600 dark:text-slate-400">
              {d.dow}
            </div>
            <div className="my-1 text-2xl" aria-hidden>
              {d.emoji || "🏖️"}
            </div>
            {d.peakScore != null ? (
              <div
                className="mx-auto flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold text-slate-950"
                style={{ background: scoreColor(d.peakScore) }}
                title={`Peak Beach Day score: ${d.peakScore}`}
              >
                {d.peakScore}
              </div>
            ) : (
              <div className="mx-auto flex h-9 w-9 items-center justify-center rounded-full bg-slate-200 text-sm font-bold text-slate-500 dark:bg-slate-800">
                —
              </div>
            )}
            <div className="mt-2 text-[11px] leading-tight text-slate-600 dark:text-slate-300">
              {d.best ? (
                <>
                  {fmtTime(d.best.startIso, tz)}
                  <span className="text-slate-400">–</span>
                  {fmtTime(d.best.endIso, tz)}
                </>
              ) : (
                <span className="text-slate-400">no good window</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
