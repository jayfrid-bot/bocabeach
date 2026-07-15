import type { LightningData, Wrapped } from "@/lib/types";
import { degToCardinal, round } from "@/lib/util";
import {
  RADAR_MAX_MI,
  RADAR_RINGS_MI,
  RADAR_SAFETY_RING_MI,
  bearingDistanceToPoint,
  radarBandCounts,
  radarBandDotAngles,
  radarRadiusFraction,
} from "@/lib/lightningRadar";

// Square viewBox; center is the beach. MAX_R leaves margin around the 50 mi
// ring for the N indicator and ring labels.
const SIZE = 220;
const CENTER = SIZE / 2;
const MAX_R = 92;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** A point on the unit circle (relative to center) for placing ring labels
 *  just inside the ring, offset from the N marker and NE quadrant labels so
 *  nothing collides with the north indicator. Rounded to 2 decimals — same
 *  hydration-safety convention as `bearingDistanceToPoint` — so raw trig
 *  doesn't disagree in its last digit between the server and client render. */
function labelPoint(radiusPx: number, angleDeg: number) {
  const r = radiusPx;
  const rad = toRad(angleDeg);
  return { x: round(CENTER + r * Math.sin(rad), 2), y: round(CENTER - r * Math.cos(rad), 2) };
}

function ageLabel(min?: number): string {
  if (min == null) return "";
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)}h ago`;
}

/**
 * Top-down range-ring plot of the nearest lightning strike relative to the
 * beach. Purely a visualization of `lightning` — carries none of its own
 * data-fetching or staleness logic; the caller (LightningCard) decides
 * whether the feed is trustworthy enough to show as "live."
 *
 * `muted` renders the radar greyed-out with no strike/density markings for
 * a stale/errored/unavailable feed — this is a safety display, so an unknown
 * state must never look like "clear."
 */
export function LightningRadar({
  lightning,
  muted,
}: {
  lightning: Wrapped<LightningData>;
  muted: boolean;
}) {
  const d = lightning.data;
  const win = d?.windowMinutes ?? 30;

  if (!d) return null;

  const counts = radarBandCounts(d);
  const hasNearest = !muted && d.nearestMi != null && d.nearestBearingDeg != null;
  const nearestPoint =
    hasNearest && d.nearestMi != null && d.nearestBearingDeg != null
      ? bearingDistanceToPoint(d.nearestBearingDeg, d.nearestMi, MAX_R)
      : null;
  const isEmpty = !muted && d.totalInArea === 0;

  const ringOpacity = muted ? 0.35 : 1;

  return (
    <div className="mt-3">
      <div className="relative mx-auto aspect-square w-full max-w-[220px]">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="h-full w-full"
          role="img"
          aria-label={
            muted
              ? "Strike radar unavailable — feed delayed"
              : isEmpty
                ? `Strike radar: no strikes within ${RADAR_MAX_MI} mi in the last ${win} min`
                : hasNearest && d.nearestMi != null && d.nearestBearingDeg != null
                  ? `Strike radar: nearest strike ${d.nearestMi} mi ${degToCardinal(d.nearestBearingDeg)} of the beach`
                  : "Strike radar"
          }
        >
          {/* Range rings */}
          <g opacity={ringOpacity}>
            {RADAR_RINGS_MI.map((mi) => {
              const r = round(radarRadiusFraction(mi) * MAX_R, 2);
              const isSafety = mi === RADAR_SAFETY_RING_MI;
              return (
                <circle
                  key={mi}
                  cx={CENTER}
                  cy={CENTER}
                  r={r}
                  fill="none"
                  className={
                    isSafety
                      ? "stroke-rose-500/70 dark:stroke-rose-400/70"
                      : "stroke-slate-400/35 dark:stroke-white/20"
                  }
                  strokeWidth={isSafety ? 1.5 : 1}
                  strokeDasharray={isSafety ? "3 3" : undefined}
                />
              );
            })}

            {/* Ring labels, tucked into the SE quadrant to stay clear of N
                and the density annotations. */}
            {RADAR_RINGS_MI.map((mi) => {
              const r = round(radarRadiusFraction(mi) * MAX_R, 2);
              const p = labelPoint(r, 150);
              return (
                <text
                  key={mi}
                  x={p.x}
                  y={p.y}
                  fontSize={7}
                  textAnchor="middle"
                  className={
                    mi === RADAR_SAFETY_RING_MI
                      ? "fill-rose-500/80 dark:fill-rose-400/80"
                      : "fill-slate-400 dark:fill-white/40"
                  }
                >
                  {mi}
                </text>
              );
            })}

            {/* Center = the beach */}
            <circle cx={CENTER} cy={CENTER} r={3} className="fill-slate-700 dark:fill-white/80" />

            {/* North indicator */}
            <g className="fill-slate-500 dark:fill-white/50">
              <text x={CENTER} y={CENTER - MAX_R - 6} fontSize={9} textAnchor="middle" fontWeight={600}>
                N
              </text>
              <path
                d={`M${CENTER},${CENTER - MAX_R + 2} l-3,7 l3,-2.5 l3,2.5 Z`}
                className="fill-slate-400 dark:fill-white/30"
              />
            </g>
          </g>

          {/* Band density: subtle per-annulus strike counts. Not real strike
              positions (only the nearest strike's true bearing is known) —
              deliberately faint so they read as texture, not events. */}
          {!muted && !isEmpty && (
            <g>
              {(
                [
                  { count: counts.inner, rIn: 0, rOut: radarRadiusFraction(10) * MAX_R, label: counts.inner },
                  {
                    count: counts.mid,
                    rIn: radarRadiusFraction(10) * MAX_R,
                    rOut: radarRadiusFraction(25) * MAX_R,
                    label: counts.mid,
                  },
                  {
                    count: counts.outer,
                    rIn: radarRadiusFraction(25) * MAX_R,
                    rOut: radarRadiusFraction(50) * MAX_R,
                    label: counts.outer,
                  },
                ] as const
              ).map((band, i) => {
                if (band.count <= 0) return null;
                const midR = (band.rIn + band.rOut) / 2;
                const angles = radarBandDotAngles(band.count);
                return (
                  <g key={i}>
                    {angles.map((angle, j) => {
                      const p = labelPoint(midR, angle);
                      return (
                        <circle
                          key={j}
                          cx={p.x}
                          cy={p.y}
                          r={1.4}
                          className="fill-amber-500/50 dark:fill-amber-300/45"
                        />
                      );
                    })}
                    {/* Count label near the bottom of the band, out of the
                        way of N and the nearest-strike marker. */}
                    <text
                      x={labelPoint(midR, 205).x}
                      y={labelPoint(midR, 205).y}
                      fontSize={7}
                      textAnchor="middle"
                      className="fill-slate-500 dark:fill-white/45"
                    >
                      {band.count}
                    </text>
                  </g>
                );
              })}
            </g>
          )}

          {/* Nearest strike */}
          {nearestPoint && (
            <g transform={`translate(${CENTER + nearestPoint.x}, ${CENTER + nearestPoint.y})`}>
              <circle
                r={7}
                className="fill-rose-500/25 dark:fill-rose-400/25"
                style={{ animation: "lightningpulse 2.4s ease-in-out infinite" }}
              />
              <text x={0} y={0} fontSize={11} textAnchor="middle" dominantBaseline="central" aria-hidden>
                ⚡
              </text>
            </g>
          )}
        </svg>

        {muted && (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-white/40 text-center text-[11px] font-medium text-slate-500 dark:bg-slate-900/40 dark:text-slate-400">
            <span className="px-4">Feed delayed — radar hidden</span>
          </div>
        )}
      </div>

      {!muted && (
        <div className="mt-1 text-center text-[11px] text-slate-500 dark:text-slate-400">
          {isEmpty
            ? `No strikes within ${RADAR_MAX_MI} mi in the last ${win} min`
            : d.nearestMi != null && d.nearestBearingDeg != null
              ? `${d.nearestMi} mi ${degToCardinal(d.nearestBearingDeg)} · ${ageLabel(d.nearestMinutesAgo)}`
              : null}
        </div>
      )}
    </div>
  );
}
