import type { Wrapped, TideData } from "@/lib/types";
import { fmtTime } from "@/lib/format";
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
        {tides.data?.trend ? (
          <span className="text-xs text-ocean-700 dark:text-ocean-300">
            {tides.data.trend === "rising" ? "↑ rising" : "↓ falling"}
          </span>
        ) : null}
      </div>
      {events.length === 0 ? (
        <div className="mt-2 text-sm text-slate-500">Unavailable</div>
      ) : (
        <>
          <TideCurve events={events} tz={tz} />
          <ul className="mt-2 space-y-1.5">
          {events.map((e, i) => (
            <li key={i} className="flex items-center justify-between text-sm">
              <span className="capitalize text-slate-700 dark:text-slate-300">
                {e.type === "high" ? "High" : "Low"} tide
              </span>
              <span className="text-slate-900 dark:text-white">{fmtTime(e.time, tz)}</span>
              <span className="w-12 text-right text-slate-600 dark:text-slate-400">{e.heightFt} ft</span>
            </li>
          ))}
          </ul>
        </>
      )}
    </div>
  );
}
