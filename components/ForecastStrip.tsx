import type { ForecastDay, Wrapped } from "@/lib/types";

/** 7-day outlook: one tile per day (sky emoji, hi/lo, rain %, max wind). */
export function ForecastStrip({ forecast }: { forecast: Wrapped<ForecastDay[]> }) {
  const days = forecast.data ?? [];
  if (days.length === 0) return null;

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold text-slate-900 dark:text-white">7-day outlook</h2>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {days.map((d) => (
          <div
            key={d.date}
            className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-2.5 text-center ring-1 ring-slate-900/10 dark:ring-white/10"
          >
            <div className="text-xs font-medium uppercase text-slate-600 dark:text-slate-400">{d.dow}</div>
            <div className="my-1 text-2xl" title={d.sky} aria-label={d.sky}>
              {d.emoji}
            </div>
            <div className="text-sm font-semibold text-slate-900 dark:text-white">
              {d.hi != null ? `${d.hi}°` : "—"}
            </div>
            <div className="text-xs text-slate-500">{d.lo != null ? `${d.lo}°` : "—"}</div>
            {d.rain != null ? (
              <div className="mt-1 text-[11px] font-medium text-ocean-700 dark:text-ocean-300">💧 {d.rain}%</div>
            ) : null}
            {d.windMaxMph != null ? (
              <div className="text-[11px] text-slate-500">💨 {d.windMaxMph}</div>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
