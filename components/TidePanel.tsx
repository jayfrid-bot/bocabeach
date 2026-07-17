import type { Wrapped, TideData } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { TideCrossSection } from "@/components/TideCrossSection";
import { TideCurve } from "@/components/TideCurve";

export function TidePanel({ tides, tz }: { tides: Wrapped<TideData>; tz: string }) {
  const events = tides.data?.next ?? [];
  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>🌊</span>
          <span>Tides</span>
        </div>
        {/* Prominent rising/falling status — the quick "which way is the water
            going" read that the sparse pre-graphic card made obvious. Kept as a
            bold color-coded pill (rising = ocean blue, falling = amber) so it
            still stands out next to the cross-section graphic. */}
        {tides.data?.trend ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold ring-1 ${
              tides.data.trend === "rising"
                ? "bg-ocean-500/10 text-ocean-700 ring-ocean-500/25 dark:text-ocean-300"
                : "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300"
            }`}
          >
            <span aria-hidden>{tides.data.trend === "rising" ? "↑" : "↓"}</span>
            {tides.data.trend === "rising" ? "Rising" : "Falling"}
          </span>
        ) : null}
      </div>
      {events.length === 0 ? (
        <div className="mt-2 text-sm text-slate-500">Unavailable</div>
      ) : (
        <>
          <TideCrossSection events={events} trend={tides.data?.trend} tz={tz} />
          {/* The classic rise/fall curve over the cycle, restored alongside the
              cross-section (owner wanted both) — a "you are here" marker rides
              the curve so the trend is legible at a glance. */}
          <div className="mt-3 border-t border-slate-900/10 pt-2 dark:border-white/10">
            <div className="text-[11px] text-slate-500 dark:text-slate-500">Tide cycle</div>
            <TideCurve events={events} tz={tz} />
          </div>
          {/* Secondary/compact — the cross-section above is the primary read;
              this list is the precise backup (exact times + heights). */}
          <ul className="mt-2 space-y-1 border-t border-slate-900/10 pt-2 dark:border-white/10">
            {events.map((e, i) => (
              <li key={i} className="flex items-center justify-between text-xs">
                <span className="capitalize text-slate-600 dark:text-slate-400">
                  {e.type === "high" ? "High" : "Low"} tide
                </span>
                <span className="text-slate-700 dark:text-slate-300">{fmtTime(e.time, tz)}</span>
                <span className="w-10 text-right text-slate-500 dark:text-slate-500">{e.heightFt} ft</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
