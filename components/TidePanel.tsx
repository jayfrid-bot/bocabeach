import type { Wrapped, TideData } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { TideCrossSection } from "@/components/TideCrossSection";
import { TideCurve } from "@/components/TideCurve";

export function TidePanel({ tides, tz }: { tides: Wrapped<TideData>; tz: string }) {
  const events = tides.data?.next ?? [];
  const ab = tides.data?.aberration;

  // Aberration call-outs — rendered ONLY when today's tides actually escape the
  // normal band, so a normal day adds nothing here. King highs get an amber tone
  // (they flood A1A + beach parking); unusually low lows get a cyan tone (the fun
  // aberration: sandbars + tide pools). Highs and lows can both fire the same day
  // (spring tides swing wider at both ends), so up to two lines can show.
  const badges: { key: string; text: string; tone: string }[] = [];
  if (ab) {
    if (ab.highStatus === "king") {
      badges.push({
        key: "high",
        text: `King tide — highs ≈${Math.abs(ab.deltaHighFt).toFixed(1)} ft above normal`,
        tone: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
      });
    } else if (ab.highStatus === "elevated") {
      badges.push({
        key: "high",
        text: `Higher than normal tides — highs ≈${Math.abs(ab.deltaHighFt).toFixed(1)} ft up`,
        tone: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
      });
    }
    if (ab.lowStatus === "very-low") {
      badges.push({
        key: "low",
        text: `Unusually low tide today — ≈${Math.abs(ab.deltaLowFt).toFixed(1)} ft below normal`,
        tone: "bg-cyan-500/10 text-cyan-700 ring-cyan-500/25 dark:text-cyan-300",
      });
    } else if (ab.lowStatus === "low") {
      badges.push({
        key: "low",
        text: `Lower than normal low tides — ≈${Math.abs(ab.deltaLowFt).toFixed(1)} ft down`,
        tone: "bg-cyan-500/10 text-cyan-700 ring-cyan-500/25 dark:text-cyan-300",
      });
    }
  }

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
          {badges.length > 0 ? (
            <div className="mt-2 flex flex-col gap-1">
              {badges.map((b) => (
                <span
                  key={b.key}
                  className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${b.tone}`}
                >
                  <span aria-hidden>{b.key === "high" ? "🌊" : "🏖️"}</span>
                  {b.text}
                </span>
              ))}
            </div>
          ) : null}
          <TideCrossSection events={events} trend={tides.data?.trend} tz={tz} aberration={ab} />
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
