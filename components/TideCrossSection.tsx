"use client";

import { useEffect, useState } from "react";
import type { TideEvent } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { computeTideLevel } from "@/lib/tideLevel";
import { clamp } from "@/lib/util";

// viewBox geometry. WIDTH/TILE match WaveHeightCard.tsx exactly so the
// lapping-water layer can reuse its `wavescroll`/`wavescroll-rev` keyframes
// from globals.css (a seamless scroll of exactly WIDTH px) without adding
// any new CSS. HEIGHT is a coordinate scale only — the SVG stretches to fill
// the card's actual CSS box (`preserveAspectRatio="none"`), so what matters
// is the RELATIVE proportion given to sky vs. water vs. sand below, not this
// absolute number.
const WIDTH = 400;
const HEIGHT = 190;
const TILE = WIDTH * 2;
const WAVELENGTH = WIDTH / 2;
const STEP = 10;

// A fixed horizon, the same at every tide level — real ocean horizons don't
// move with the tide, only the LOCAL shoreline does. This is what fixes the
// old design's core problem: that version's "sky" was whatever the terrain
// line didn't cover, so at low tide (terrain riding high across most of the
// frame) the sky ballooned to fill most of the card and the water was
// squeezed into a sliver. Here the ocean below is a full-width, full-height
// -below-horizon body that's ALWAYS present, so there's no gap for sky to
// leak through at any tide level, and the water always reads as substantial.
const HORIZON_Y = 40;

// The dune/sand wedge only occupies the right portion of the frame — left of
// SAND_X0 is permanently open ocean (no tide ever exposes sand there), which
// is what makes the water read as a real sea rather than a band clinging to
// one corner. The wedge itself is one straight slope (a real beach profile
// has bars and troughs, but a single honest slope reads instantly at a
// glance) from the always-wet inner edge (x=SAND_X0) up to the dry dune tip
// (x=WIDTH, meeting the horizon exactly — no color gap between them).
const SAND_X0 = 130;
const SAND_BOTTOM_Y = HEIGHT; // terrain y at x = SAND_X0
const SAND_TOP_Y = HORIZON_Y; // terrain y at x = WIDTH
const SAND_RISE = SAND_BOTTOM_Y - SAND_TOP_Y;
const terrainY = (x: number) => {
  const cx = clamp(x, SAND_X0, WIDTH);
  return SAND_BOTTOM_Y - ((cx - SAND_X0) / (WIDTH - SAND_X0)) * SAND_RISE;
};
const terrainX = (y: number) =>
  clamp(SAND_X0 + ((SAND_BOTTOM_Y - y) / SAND_RISE) * (WIDTH - SAND_X0), SAND_X0, WIDTH);

// Where the shoreline sits on the slope at the lowest vs. highest known tide
// in the current window. Even at the LOW end most of the dune wedge is
// already wet (0.30 of the way up) and at the HIGH end almost all of it is
// (0.75), so the visible dry-sand strip shrinks to just the dune tip rather
// than the water ever looking like a thin edge case.
const SHORE_X_LOW = SAND_X0 + (WIDTH - SAND_X0) * 0.3;
const SHORE_X_HIGH = SAND_X0 + (WIDTH - SAND_X0) * 0.75;
const SHORE_Y_LOW = terrainY(SHORE_X_LOW);
const SHORE_Y_HIGH = terrainY(SHORE_X_HIGH);
const waterlineY = (fraction: number) => SHORE_Y_LOW + fraction * (SHORE_Y_HIGH - SHORE_Y_LOW);

// Small unlabeled ticks on the always-dry dune (fixed spot, never covered by
// water at any tide) marking the two ends of the current window's fractional
// range — i.e. exactly where the waterline sits at fraction 0 and fraction 1
// — so "where the water is now" reads against the full swing it moves
// through today, not in isolation. No text: numbers here would either
// duplicate the tide list below or collide with the next-event label.
const REF_TICK_X1 = WIDTH - 4;
const REF_TICK_X2 = WIDTH - 15;

// Coordinates rounded to 2 decimals so SSR and client hydration paths agree
// exactly (same convention as WaveHeightCard.tsx / ScoreWheel.tsx).
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A gentle lapping ripple riding along the waterline, tiled twice for a
 *  seamless `wavescroll` loop (identical technique to WaveHeightCard.tsx). */
/**
 * A ripple band hugging the water SURFACE: the sine crest down to `depth`
 * below it — NOT down to the frame bottom. Closing these at HEIGHT (as they
 * originally did) made each "ripple" a translucent sheet over the whole water
 * body; two stacked at ~0.5 opacity washed the sea pale below the waterline
 * and read as a hard seam against the deeper water above it.
 */
function rippleTopPath(
  waterY: number,
  amplitude: number,
  phaseRad: number,
  depth = 7,
): string {
  const pts: string[] = [];
  for (let x = 0; x <= TILE; x += STEP) {
    const y = waterY + amplitude * Math.sin((2 * Math.PI * x) / WAVELENGTH + phaseRad);
    pts.push(`${x},${round2(y)}`);
  }
  const base = round2(waterY + depth);
  return `M0,${base} L${pts.join(" L")} L${TILE},${base} Z`;
}

/**
 * The tide as a side-view beach cross-section: a cropped strip of sky over a
 * full-width ocean, a foreground dune wedge on the right, and a gently
 * lapping waterline positioned by the current interpolated tide height. A
 * tick marks where the water will reach at the next high/low; two fainter
 * static ticks mark the current window's low/high extremes for context.
 */
export function TideCrossSection({
  events,
  trend,
  tz,
}: {
  events: TideEvent[];
  trend?: "rising" | "falling";
  tz: string;
}) {
  // Clock is client-only (set after mount) so SSR and hydration HTML match;
  // pre-mount we render a static neutral mid-tide frame instead of guessing.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const level = nowMs != null ? computeTideLevel(events, nowMs, trend) : null;
  const fraction = level?.fraction ?? 0.5; // neutral mid-tide pre-mount / no data
  const waterY = waterlineY(fraction);
  const shoreX = terrainX(waterY);

  // Next event tick: where on the slope the water will reach at the next
  // reported high/low, positioned on the SAME fraction scale as the current
  // waterline (using the current window's lo/hi) so it's directly comparable.
  const next = events[0];
  let nextTick: { x: number; y: number; label: string } | null = null;
  if (next && level) {
    const span = Math.max(level.hiFt - level.loFt, 0.001);
    const nextFraction = Math.min(1, Math.max(0, (next.heightFt - level.loFt) / span));
    const y = waterlineY(nextFraction);
    nextTick = {
      x: terrainX(y),
      y,
      label: `${next.type === "high" ? "High" : "Low"} ${fmtTime(next.time, tz)}`,
    };
  }

  const mounted = nowMs != null;

  return (
    <div className="relative mt-2 h-40 w-full overflow-hidden rounded-xl bg-sky-100 dark:bg-slate-950/50 sm:h-48">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        {/* One sea, graded by depth. The deep-ocean base and the nearshore
            water used to be two flat, unrelated blues meeting at a hard edge at
            the waterline — which read as two stacked bands (a rendering fault),
            not as one body of water. This gradient runs the base from a deep
            tone at the horizon down to EXACTLY the nearshore fill (#32a4ff), so
            the two layers resolve into a single sea with an honest depth cue. */}
        <defs>
          <linearGradient id="tidecs-sea" x1="0" y1={HORIZON_Y} x2="0" y2={HEIGHT} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#0b4f8f" />
            <stop offset="1" stopColor="#32a4ff" />
          </linearGradient>
        </defs>

        {/* sky: a fixed, tightly cropped band — cropped hard so the ocean
            below dominates the frame at every tide level */}
        <rect x={0} y={0} width={WIDTH} height={HORIZON_Y} className="fill-sky-200 dark:fill-[#0f1f3d]" />

        {/* ocean: always present for the full width below the horizon. The
            richer/darker tone (vs. the brighter nearshore water below) reads
            as depth — deep sea in the background, lighter shallows up close
            — and guarantees there's never a sky-colored gap for any tide. */}
        <rect
          x={0}
          y={HORIZON_Y}
          width={WIDTH}
          height={HEIGHT - HORIZON_Y}
          fill="url(#tidecs-sea)"
        />

        {/* dry sand: the fixed dune wedge silhouette, foreground only (right
            side) — the part of it below the current waterline gets painted
            over by the nearshore water layer below. */}
        <path
          d={`M${SAND_X0},${SAND_BOTTOM_Y} L${WIDTH},${SAND_TOP_Y} L${WIDTH},${HEIGHT} L${SAND_X0},${HEIGHT} Z`}
          className="fill-amber-100 dark:fill-[#4a3c26]"
        />

        {/* Static low/high reference ticks — see REF_TICK_X1/2 comment above. */}
        <g stroke="#0f172a" strokeOpacity={0.3} strokeWidth={1.25} className="dark:stroke-white/35">
          <line x1={REF_TICK_X2} x2={REF_TICK_X1} y1={round2(SHORE_Y_LOW)} y2={round2(SHORE_Y_LOW)} />
          <line x1={REF_TICK_X2} x2={REF_TICK_X1} y1={round2(SHORE_Y_HIGH)} y2={round2(SHORE_Y_HIGH)} />
        </g>

        {/* nearshore water: clipped to exactly the current tide's wet area —
            re-covers whatever part of the dune wedge is submerged right now,
            and carries the animated lapping ripples at today's waterline. */}
        <clipPath id="tidecs-water-clip">
          <rect x={0} y={round2(waterY)} width={round2(shoreX)} height={round2(HEIGHT - waterY)} />
        </clipPath>
        <g clipPath="url(#tidecs-water-clip)">
          {/* Painted with the SAME sea gradient as the base, so there is no
              colour discontinuity where the two layers meet — a flat fill here
              left a hard horizontal seam at the waterline that read as a
              rendering fault. The water is one graded body; the waterline is
              legible where it meets the sand, plus the ripples below. */}
          <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="url(#tidecs-sea)" />
          <path
            d={rippleTopPath(waterY, 2.2, 0.4)}
            fill="rgba(142, 216, 255, 0.55)"
            style={mounted ? { animation: "wavescroll 6s linear infinite" } : undefined}
          />
          <path
            d={rippleTopPath(waterY, 1.4, 3.1)}
            fill="rgba(186, 230, 253, 0.5)"
            style={mounted ? { animation: "wavescroll-rev 8s linear infinite" } : undefined}
          />
        </g>

        {/* Next high/low tick on the dry slope. This is the ONLY text label
            drawn inside the SVG — the rising/falling trend is shown once,
            in the card header above (TidePanel.tsx), not duplicated here,
            which is what used to collide with this label at near-low tide
            (both landed in the lower-left corner). The label's y is clamped
            away from the top/bottom frame edges and it carries a stroke
            halo so it stays legible over sky, sand, or water. */}
        {nextTick ? (
          <g>
            <line
              x1={nextTick.x}
              y1={nextTick.y - 8}
              x2={nextTick.x}
              y2={nextTick.y + 8}
              stroke="#0f172a"
              strokeOpacity={0.55}
              strokeWidth={1.5}
              className="dark:stroke-white/60"
            />
            <text
              x={Math.min(WIDTH - 4, Math.max(4, nextTick.x))}
              y={Math.min(HEIGHT - 5, Math.max(11, nextTick.y - 13))}
              textAnchor={nextTick.x > WIDTH - 60 ? "end" : nextTick.x < 60 ? "start" : "middle"}
              fontSize="11"
              fontWeight={700}
              fill="#0f172a"
              stroke="#ffffff"
              strokeWidth={3}
              strokeLinejoin="round"
              paintOrder="stroke"
              className="dark:fill-white dark:stroke-slate-950"
            >
              {nextTick.label}
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}
