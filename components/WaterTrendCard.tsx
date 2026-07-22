import type { WaterTrendResult } from "@/lib/waterTrend";

/**
 * Water "feel" trend — the insider-signal sub-line for water temp: how the
 * ocean has actually MOVED over the last couple of days, not just its current
 * reading. Quiet by default (renders nothing on "steady"), the same posture
 * as TidePanel's aberration badges — a normal day adds nothing to the UI.
 *
 * Visual language matches TidePanel's badges: a small pill, cyan for the
 * "cold" calls (upwelling/cooling — same tone TidePanel uses for its low-tide
 * badge), warm amber for warming-fast (TidePanel's high-tide/king-tide tone).
 * Props-driven and self-contained — pass it the already-computed
 * `WaterTrendResult` (from `lib/waterTrend.ts`); it does no fetching itself.
 */
export function WaterTrendCard({ trend }: { trend: WaterTrendResult | null }) {
  if (!trend || trend.status === "steady") return null;

  const isWarming = trend.status === "warming-fast";
  const tone = isWarming
    ? "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300"
    : "bg-cyan-500/10 text-cyan-700 ring-cyan-500/25 dark:text-cyan-300";
  const icon = isWarming ? "🌡️" : "🥶";
  const magnitude = Math.abs(trend.deltaF48h).toFixed(1);
  const label =
    trend.status === "upwelling"
      ? `Cold upwelling — water down ${magnitude}°F in 2 days`
      : trend.status === "cooling"
        ? `Cooling — water down ${magnitude}°F in 2 days`
        : `Warming fast — water up ${magnitude}°F in 2 days`;

  return (
    <span
      className={`inline-flex items-center gap-1.5 self-start rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ${tone}`}
      title={trend.note}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </span>
  );
}
