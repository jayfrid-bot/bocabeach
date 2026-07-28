import type { RainNowcast } from "@/lib/rainNowcast";
import type { StormActivityBand, StormActivityData } from "@/lib/types";

// Same gradient-construction style as AirQualityMeter's AQI_BANDS: list each
// band's color at its upper-bound percentage (scale here is already 0-100, so
// no separate SCALE_MAX is needed).
const GRADIENT =
  "linear-gradient(to right, #34d399 25%, #fbbf24 50%, #fb923c 75%, #fb7185 100%)";

const BAND_TEXT_CLASS: Record<StormActivityBand, string> = {
  Calm: "text-emerald-600 dark:text-emerald-400",
  Unsettled: "text-amber-600 dark:text-amber-400",
  Stormy: "text-orange-600 dark:text-orange-400",
  Severe: "text-rose-700 dark:text-rose-400",
};

/**
 * Horizontal 0-100 Storm Activity meter: strike density + proximity + current
 * rain rolled into one gauge, modeled closely on AirQualityMeter. Renders
 * nothing when the metric is null (lightning feed down/stale AND rain data
 * alone doesn't justify showing it — see lib/stormActivity.ts).
 */
export function StormActivityMeter({
  storm,
  /** The radar rain-nowcast line, or null when the radar has nothing current to
   *  say (see lib/rainNowcast.ts). Optional so any other call site keeps
   *  working unchanged. */
  rain = null,
}: {
  storm: StormActivityData | null;
  rain?: RainNowcast | null;
}) {
  if (!storm) return null;
  const { score, band } = storm;
  const pct = Math.max(0, Math.min(100, score));

  return (
    // Same stretched-column treatment as AirQualityMeter, so the two meter cards
    // and the (taller) lightning radar read as one band with their content
    // vertically distributed instead of pinned to the top.
    <div className="flex h-full flex-col rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>⛈️</span>
          <span>Storm activity</span>
        </div>
        <div className="text-right leading-none">
          <span className="text-2xl font-bold tabular-nums text-slate-900 dark:text-white sm:text-3xl">
            {score}
          </span>
          <span className={`ml-2 text-xs font-medium ${BAND_TEXT_CLASS[band]}`}>{band}</span>
        </div>
      </div>

      <div className="flex flex-1 flex-col justify-center">
        <div className="relative mt-3 h-2.5 rounded-full" style={{ background: GRADIENT }}>
          <div
            className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-2 ring-slate-900"
            style={{ left: `${pct}%` }}
            aria-hidden
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] text-slate-500">
          <span>Calm</span>
          <span>Unsettled</span>
          <span>Stormy</span>
          <span>Severe</span>
        </div>

        <div className="mt-2 break-words text-xs text-slate-600 dark:text-slate-400">
          Lightning strikes + rain within ~20 miles of the beach
          {/* Say so when the rain half of that sentence is a radar OBSERVATION
              rather than a forecast — the distinction is the whole point of the
              MRMS feed, and it's what earns the gauge extra trust. */}
          {storm.rainFromRadar ? " · rain observed by radar" : null}
        </div>

        {/* One-line radar note under the gauge. Self-hides whenever the radar
            is stale, missing, or simply quiet — an observation that isn't
            current must not sound certain (see lib/rainNowcast.ts). */}
        {rain ? (
          <div className="mt-2 flex items-start gap-1.5 break-words text-xs text-amber-700 dark:text-amber-400">
            <span aria-hidden className="leading-none">
              📡
            </span>
            <span>{rain.text}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
