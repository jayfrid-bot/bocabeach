import type { LightningData, Wrapped } from "@/lib/types";
import { degToCardinal, round } from "@/lib/util";
import {
  RADAR_MAX_MI,
  RADAR_RINGS_MI,
  RADAR_SAFETY_RING_MI,
  bearingDistanceToPoint,
  radarBandCounts,
  radarBandOpacity,
  radarRadiusFraction,
} from "@/lib/lightningRadar";

// Square viewBox; center is the beach. MAX_R leaves margin around the 50 mi
// ring for the N indicator and ring labels.
const SIZE = 220;
const CENTER = SIZE / 2;
const MAX_R = 92;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** A point on the unit circle (relative to center), used to place labels at
 *  a given radius + angle. Rounded to 2 decimals — same hydration-safety
 *  convention as `bearingDistanceToPoint` — so raw trig doesn't disagree in
 *  its last digit between the server and client render. */
function labelPoint(radiusPx: number, angleDeg: number) {
  const r = radiusPx;
  const rad = toRad(angleDeg);
  return { x: round(CENTER + r * Math.sin(rad), 2), y: round(CENTER - r * Math.cos(rad), 2) };
}

// Fixed cardinal angles for the two label families, chosen so neither family
// ever collides with the other, with the N indicator, or with itself: mi
// ring labels run straight down the south radius (each at its own ring's
// distinct radius, so they stack with clear vertical gaps); band count
// labels run straight along the west radius, each centered in its own
// band's annulus. Both are far from the N marker (north) and don't depend
// on the nearest-strike bearing, which can land anywhere.
const MI_LABEL_ANGLE = 180; // south
const COUNT_LABEL_ANGLE = 270; // west

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

  // The three annuli between the range rings, each carrying its own strike
  // count. Only the nearest strike (below) has a real known bearing — these
  // bands are rendered as non-positional visual weight (ring opacity), never
  // as plotted dots, so the graphic can't be misread as strike locations.
  const bands = [
    { key: "inner", count: counts.inner, rIn: 0, rOut: radarRadiusFraction(10) * MAX_R },
    { key: "mid", count: counts.mid, rIn: radarRadiusFraction(10) * MAX_R, rOut: radarRadiusFraction(25) * MAX_R },
    { key: "outer", count: counts.outer, rIn: radarRadiusFraction(25) * MAX_R, rOut: radarRadiusFraction(50) * MAX_R },
  ] as const;

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
          {/* Band tint: NOT a filled annulus (the old version filled the
              whole band width, which at a real-but-unremarkable strike count
              like 27/84 read as a solid orange donut — "the whole region is
              on fire," its own honesty problem on top of being illegible).
              Instead, a thin accent traces just the band's own OUTER ring,
              tinted by strike COUNT only — never a plotted position, since we
              only know the true bearing of the single nearest strike below.
              Both the thin stroke and the low opacity cap (see
              RADAR_BAND_MAX_OPACITY) keep it a soft highlight, never a mass,
              even at a high count. Drawn first, underneath the neutral range
              rings/labels, so those stay crisp on top. */}
          {!muted && !isEmpty && (
            <g>
              {bands.map((band) => {
                if (band.count <= 0) return null;
                const opacity = radarBandOpacity(band.count);
                return (
                  <circle
                    key={band.key}
                    cx={CENTER}
                    cy={CENTER}
                    r={round(band.rOut, 2)}
                    fill="none"
                    strokeWidth={3}
                    className="stroke-amber-500 dark:stroke-amber-300"
                    opacity={opacity}
                  />
                );
              })}
            </g>
          )}

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

            {/* Ring labels: nudged just outside each ring, all along the same
                fixed south radius (MI_LABEL_ANGLE) so they stack in a single
                predictable column — each ring's distinct radius keeps them
                spaced apart — with a stroke halo so they stay legible over
                sky, a band tint, or another ring underneath. */}
            {RADAR_RINGS_MI.map((mi) => {
              const r = round(radarRadiusFraction(mi) * MAX_R, 2);
              const p = labelPoint(r + 5, MI_LABEL_ANGLE);
              return (
                <text
                  key={mi}
                  x={p.x}
                  y={p.y}
                  fontSize={7}
                  fontWeight={600}
                  textAnchor="middle"
                  stroke="white"
                  strokeWidth={2}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  className={
                    mi === RADAR_SAFETY_RING_MI
                      ? "fill-rose-500/80 dark:fill-rose-400/80 dark:stroke-slate-950"
                      : "fill-slate-500 dark:fill-white/50 dark:stroke-slate-950"
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

          {/* Band count labels: the raw per-band total (a count, not a
              location), placed at each band's own MID-radius along the fixed
              west radius (COUNT_LABEL_ANGLE) — a cardinal direction the mi
              ring labels (south) never use, so the two label families can
              never collide, and centering on the band's own radius (rather
              than nudging past its outer ring) keeps each count visually
              inside the annulus it describes. Stroke halo so it reads
              cleanly over the band tint or a ring line underneath. */}
          {!muted && !isEmpty && (
            <g>
              {bands.map((band) => {
                if (band.count <= 0) return null;
                const midR = (band.rIn + band.rOut) / 2;
                const p = labelPoint(midR, COUNT_LABEL_ANGLE);
                return (
                  <text
                    key={band.key}
                    x={p.x}
                    y={p.y}
                    fontSize={7}
                    fontWeight={600}
                    textAnchor="middle"
                    stroke="white"
                    strokeWidth={2}
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    className="fill-amber-700 dark:fill-amber-300 dark:stroke-slate-950"
                  >
                    {band.count}
                  </text>
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
