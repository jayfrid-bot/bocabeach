import type { TideObserved, Wrapped, TideData } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { TideCrossSection } from "@/components/TideCrossSection";
import { TideCurve } from "@/components/TideCurve";

/** Past this, a "live" gauge reading isn't live any more — CO-OPS gauges tick
 *  every 6 minutes, so an hour-old value means the station went quiet and the
 *  chip hides rather than presenting a stale number as "observed right now". */
export const OBSERVED_STALE_MINUTES = 60;

/** A residual this size is real signal (wind setup / surge / a barometric push)
 *  rather than the ±0.1-0.3 ft the harmonic prediction misses by on a normal
 *  day, so it earns a colored tone. */
const NOTABLE_DELTA_FT = 0.5;

/**
 * The observed-vs-predicted chip's text + tone, or `null` when there's nothing
 * honest to show. Pure (takes `nowMs`) so server and client agree and so the
 * staleness rule is unit-testable without rendering.
 */
export function observedChip(
  observed: TideObserved | undefined,
  nowMs: number,
): { text: string; tone: string } | null {
  if (!observed) return null;
  const obsMs = Date.parse(observed.tIso);
  if (!Number.isFinite(obsMs)) return null;
  const ageMin = (nowMs - obsMs) / 60_000;
  // Future-dated readings are as suspect as ancient ones — both mean the feed
  // isn't describing right now.
  if (ageMin > OBSERVED_STALE_MINUTES || ageMin < -OBSERVED_STALE_MINUTES) return null;

  const d = observed.deltaFt;
  // The gauge's own published name, trimmed to its place ("Lake Worth Pier,
  // Atlantic Ocean" -> "Lake Worth Pier"); never invented — fall back to the id.
  const place = observed.stationName?.split(",")[0]?.trim();
  const label = place ? `${place} gauge` : `gauge ${observed.stationId}`;
  const relation =
    Math.abs(d) < 0.05
      ? "right on prediction"
      : `${Math.abs(d).toFixed(1)} ft ${d > 0 ? "above" : "below"} predicted`;

  const tone =
    d >= NOTABLE_DELTA_FT
      ? "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300"
      : d <= -NOTABLE_DELTA_FT
        ? "bg-cyan-500/10 text-cyan-700 ring-cyan-500/25 dark:text-cyan-300"
        : "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:text-slate-300";

  return {
    text: `Observed: ${observed.heightFt.toFixed(1)} ft — ${relation} (${label})`,
    tone,
  };
}

export function TidePanel({ tides, tz }: { tides: Wrapped<TideData>; tz: string }) {
  const events = tides.data?.next ?? [];
  const ab = tides.data?.aberration;
  // Staleness is measured against the SNAPSHOT's fetch time, not Date.now():
  // this component is rendered inside a "use client" tree, so a wall-clock read
  // would differ between the SSR pass and hydration. `fetchedAt` is part of the
  // payload, so both renders agree — and "how old was the gauge reading when we
  // pulled it" is the honest question anyway.
  const snapMs = Date.parse(tides.fetchedAt);
  const obsChip = observedChip(
    tides.data?.observed,
    Number.isFinite(snapMs) ? snapMs : Date.now(),
  );

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
      {/* What the water is ACTUALLY doing vs. what the astronomy said it would
          — the one line on this card that isn't a prediction. Amber when the
          gauge is running high (wind setup / surge), cyan when it's running
          low, neutral when the harmonic model is holding. */}
      {obsChip ? (
        <div className="mt-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${obsChip.tone}`}
          >
            <span aria-hidden>📈</span>
            {obsChip.text}
          </span>
        </div>
      ) : null}
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
