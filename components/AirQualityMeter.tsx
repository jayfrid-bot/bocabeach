import type { AirQualityData, Wrapped } from "@/lib/types";
import { AQI_BANDS, AQI_SCALE_MAX, aqiBand } from "@/lib/format";

/** Build the CSS gradient stops from the AQI bands, scaled to AQI_SCALE_MAX. */
const GRADIENT = `linear-gradient(to right, ${AQI_BANDS.filter((b) => b.max <= AQI_SCALE_MAX)
  .map((b) => `${b.color} ${(b.max / AQI_SCALE_MAX) * 100}%`)
  .join(", ")})`;

/** Horizontal US-AQI meter: a colored scale with a marker at the current value. */
export function AirQualityMeter({ air }: { air: Wrapped<AirQualityData> }) {
  const d = air.data;
  const aqi = d?.usAqi;
  const known = typeof aqi === "number";
  const band = known ? aqiBand(aqi as number) : null;
  const pct = known ? Math.min(100, ((aqi as number) / AQI_SCALE_MAX) * 100) : 0;

  // Keep it simple: the number, the band, and the meter. (Per-pollutant
  // concentrations were noise for beachgoers.)
  const detail = known ? null : "Air quality data unavailable";

  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>🌫️</span>
          <span>Air quality (US AQI)</span>
        </div>
        <div className="text-right leading-none">
          <span className="text-2xl font-bold text-slate-900 dark:text-white sm:text-3xl">
            {known ? aqi : "—"}
          </span>
          {band ? (
            <span className="ml-2 text-xs font-medium text-slate-900 dark:text-white">
              {band.label}
            </span>
          ) : null}
        </div>
      </div>

      <div className="relative mt-3 h-2.5 rounded-full" style={{ background: GRADIENT }}>
        {known ? (
          <div
            className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-2 ring-slate-900"
            style={{ left: `${pct}%` }}
            aria-hidden
          />
        ) : null}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>0</span>
        <span>100</span>
        <span>200</span>
        <span>{AQI_SCALE_MAX}+</span>
      </div>

      {detail ? (
        <div className="mt-2 break-words text-xs text-slate-600 dark:text-slate-400">{detail}</div>
      ) : null}
    </div>
  );
}
