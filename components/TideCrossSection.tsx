"use client";

import { useEffect, useState } from "react";
import type { TideEvent } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { computeTideLevel } from "@/lib/tideLevel";

// viewBox geometry. WIDTH/TILE match WaveHeightCard.tsx exactly so the
// lapping-water layer can reuse its `wavescroll`/`wavescroll-rev` keyframes
// from globals.css (a seamless scroll of exactly WIDTH px) without adding
// any new CSS.
const WIDTH = 400;
const HEIGHT = 190;
const TILE = WIDTH * 2;
const WAVELENGTH = WIDTH / 2;
const STEP = 10;

// The sand slope: a straight profile from the deep-water corner (x=0, low
// in the frame = physically low ground) up to the dune corner (x=WIDTH,
// high in the frame). Kept as one straight line — a real beach profile has
// bars and troughs, but a single honest slope reads instantly at a glance,
// which is the point of this graphic.
const SAND_BOTTOM_Y = 168; // terrain y at x=0
const SAND_TOP_Y = 58; // terrain y at x=WIDTH
const SAND_RISE = SAND_BOTTOM_Y - SAND_TOP_Y;
const terrainY = (x: number) => SAND_BOTTOM_Y - (x / WIDTH) * SAND_RISE;
const terrainX = (y: number) =>
  Math.min(WIDTH, Math.max(0, ((SAND_BOTTOM_Y - y) / SAND_RISE) * WIDTH));

// Where the shoreline sits on the slope at the lowest vs. highest known
// tide in the current window — leaves a sliver of always-wet sand at the far
// left (low tide) and a sliver of dry dune at the far right (high tide) so
// the graphic never fills edge-to-edge.
const SHORE_X_LOW = WIDTH * 0.12;
const SHORE_X_HIGH = WIDTH * 0.8;
const SHORE_Y_LOW = terrainY(SHORE_X_LOW);
const SHORE_Y_HIGH = terrainY(SHORE_X_HIGH);
const waterlineY = (fraction: number) => SHORE_Y_LOW + fraction * (SHORE_Y_HIGH - SHORE_Y_LOW);

// Coordinates rounded to 2 decimals so SSR and client hydration paths agree
// exactly (same convention as WaveHeightCard.tsx / ScoreWheel.tsx).
const round2 = (v: number) => Math.round(v * 100) / 100;

/** A gentle lapping ripple riding along the waterline, tiled twice for a
 *  seamless `wavescroll` loop (identical technique to WaveHeightCard.tsx). */
function rippleTopPath(waterY: number, amplitude: number, phaseRad: number): string {
  const pts: string[] = [];
  for (let x = 0; x <= TILE; x += STEP) {
    const y = waterY + amplitude * Math.sin((2 * Math.PI * x) / WAVELENGTH + phaseRad);
    pts.push(`${x},${round2(y)}`);
  }
  return `M0,${HEIGHT} L${pts.join(" L")} L${TILE},${HEIGHT} Z`;
}

/**
 * The tide as a side-view beach cross-section: sky above, sand sloping from
 * deep water up to dry dune, and a gently lapping waterline positioned by
 * the current interpolated tide height. A tick marks where the water will
 * reach at the next high/low.
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
  const trendLabel = trend === "rising" ? "Rising" : trend === "falling" ? "Falling" : null;

  return (
    <div className="relative mt-2 h-40 w-full overflow-hidden rounded-xl bg-sky-100 dark:bg-slate-950/50 sm:h-48">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        {/* sky */}
        <rect
          x={0}
          y={0}
          width={WIDTH}
          height={HEIGHT}
          className="fill-sky-200 dark:fill-[#0f1f3d]"
        />

        {/* sand: the full slope profile down to the bottom of the frame */}
        <path
          d={`M0,${SAND_BOTTOM_Y} L${WIDTH},${SAND_TOP_Y} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`}
          className="fill-amber-100 dark:fill-[#4a3c26]"
        />

        {/* water: the wedge between the waterline and the (wet) sand below it,
            clipped to the actual waterline so it never spills onto dry sand */}
        <clipPath id="tidecs-water-clip">
          <path d={`M0,${round2(waterY)} L${round2(shoreX)},${round2(waterY)} L0,${round2(SAND_BOTTOM_Y)} Z`} />
        </clipPath>
        <g clipPath="url(#tidecs-water-clip)">
          <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="#1b85f5" opacity={0.9} />
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

        {/* next high/low tick on the dry slope */}
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
              y={nextTick.y - 13}
              textAnchor={nextTick.x > WIDTH - 60 ? "end" : "middle"}
              fontSize="11"
              fontWeight={600}
              fill="#0f172a"
              className="dark:fill-white"
            >
              {nextTick.label}
            </text>
          </g>
        ) : null}

        {/* rising/falling indicator at the waterline */}
        {trendLabel ? (
          <g transform={`translate(${round2(Math.max(24, shoreX - 20))}, ${round2(waterY)})`}>
            <text
              x={0}
              y={-8}
              textAnchor="middle"
              fontSize="12"
              fontWeight={700}
              fill="#ffffff"
              stroke="#0f172a"
              strokeWidth={3}
              strokeLinejoin="round"
              paintOrder="stroke"
            >
              {trend === "rising" ? "↑" : "↓"} {trendLabel}
            </text>
          </g>
        ) : null}
      </svg>
    </div>
  );
}
