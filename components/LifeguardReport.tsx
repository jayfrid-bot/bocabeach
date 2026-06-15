import type { CityOfficialData, Wrapped } from "@/lib/types";

/**
 * Small card showing the City's official posted hazards and marine life
 * sightings. Previously part of the safety header — moved into its own
 * compact card so the header stays focused on red/yellow danger signals.
 */
export function LifeguardReport({ city }: { city: Wrapped<CityOfficialData> }) {
  const data = city.data;
  const marine = data?.marineLife ?? [];
  const hazards = data?.hazards ?? [];
  if (!data || (marine.length === 0 && hazards.length === 0)) return null;

  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🛟</span>
        <span>Lifeguard report</span>
      </div>

      <div className="mt-2 space-y-1.5 text-sm">
        {marine.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-2 text-slate-700 dark:text-slate-200">
            <span aria-hidden>🪼</span>
            <span className="text-xs uppercase tracking-wide text-slate-500">
              Marine life
            </span>
            <span>{marine.join(", ")}</span>
          </div>
        ) : null}
        {hazards.length > 0 ? (
          <div className="flex flex-wrap items-baseline gap-2 text-slate-700 dark:text-slate-200">
            <span aria-hidden>⚠</span>
            <span className="text-xs uppercase tracking-wide text-slate-500">
              Hazards
            </span>
            <span>{hazards.join(", ")}</span>
          </div>
        ) : null}
      </div>

      <p className="mt-3 text-[11px] text-slate-500">
        Official report from {city.attribution}
        {data.updatedLabel ? ` · ${data.updatedLabel}` : ""}. Always heed posted
        signs and lifeguards.
      </p>
    </div>
  );
}
