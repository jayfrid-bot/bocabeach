import type { LightningData, Wrapped } from "@/lib/types";
import { degToCardinal } from "@/lib/util";

function ageLabel(min?: number): string {
  if (min == null) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)}h ago`;
}

/** Nearest lightning strike + recency from NOAA GOES GLM. */
export function LightningCard({ lightning }: { lightning: Wrapped<LightningData> }) {
  const d = lightning.data;
  const win = d?.windowMinutes ?? 30;

  // Resolve a tone + headline from the data.
  let ring = "ring-white/10";
  let bg = "bg-slate-900/70";
  let accent = "#94a3b8";
  let headline: string;
  let sub: string | null = null;

  if (!d) {
    headline = "—";
    sub = "lightning data unavailable";
  } else if (d.totalInArea === 0) {
    accent = "#34d399"; // emerald
    headline = "All clear";
    sub = `No strikes detected within range in the last ${win} min`;
  } else {
    const near = d.nearestMi ?? 0;
    const dir = d.nearestBearingDeg != null ? ` ${degToCardinal(d.nearestBearingDeg)}` : "";
    headline = `${near} mi${dir} · ${ageLabel(d.nearestMinutesAgo)}`;
    sub =
      `${d.within10mi} within 10 mi · ${d.within25mi} within 25 mi` +
      ` (last ${win} min)`;
    if (d.within10mi > 0) {
      accent = "#fb7185"; // rose — close strikes
      bg = "bg-rose-500/10";
      ring = "ring-rose-500/40";
    } else if (d.within25mi > 0) {
      accent = "#fbbf24"; // amber — nearby
    }
  }

  return (
    <div className={`rounded-2xl ${bg} p-4 ring-1 ${ring}`}>
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <span aria-hidden>⚡</span>
        <span>Lightning — nearest strike</span>
      </div>
      <div className="mt-1 text-xl font-semibold sm:text-2xl" style={{ color: accent }}>
        {headline}
      </div>
      {sub ? <div className="mt-0.5 break-words text-xs text-slate-400">{sub}</div> : null}
      <div className="mt-2 text-[11px] text-slate-500">
        NOAA GOES-19 GLM
        {d?.dataAgeMinutes != null ? ` · as of ${ageLabel(d.dataAgeMinutes)}` : ""}
      </div>
    </div>
  );
}
