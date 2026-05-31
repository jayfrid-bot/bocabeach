import type { ForecastDay, Wrapped } from "@/lib/types";
import { Surface, SectionTitle } from "@/components/ui";

/** 7-day outlook: one tile per day (sky emoji, hi/lo, rain %, max wind). */
export function ForecastStrip({ forecast }: { forecast: Wrapped<ForecastDay[]> }) {
  const days = forecast.data ?? [];
  if (days.length === 0) return null;

  return (
    <section>
      <SectionTitle kicker="next 7 days">Outlook</SectionTitle>
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {days.map((d) => (
          <Surface key={d.date} className="p-2.5 text-center">
            <div className="font-head text-xs font-semibold uppercase text-ink-soft">
              {d.dow}
            </div>
            <div className="my-1 text-2xl" title={d.sky} aria-label={d.sky}>
              {d.emoji}
            </div>
            <div className="font-head text-sm font-bold text-ink">
              {d.hi != null ? `${d.hi}°` : "—"}
            </div>
            <div className="text-xs text-ink-faint">{d.lo != null ? `${d.lo}°` : "—"}</div>
            {d.rain != null ? (
              <div className="mt-1 text-[11px] font-semibold text-sea-deep">💧 {d.rain}%</div>
            ) : null}
            {d.windMaxMph != null ? (
              <div className="text-[11px] text-ink-faint">💨 {d.windMaxMph}</div>
            ) : null}
          </Surface>
        ))}
      </div>
    </section>
  );
}
