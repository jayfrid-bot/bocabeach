"use client";

import { useEffect, useState } from "react";
import type { TideEvent } from "@/lib/types";
import type { TideAberration } from "@/lib/tideAberration";
import { fmtTime } from "@/lib/format";
import { computeTideLevel } from "@/lib/tideLevel";
import { clamp } from "@/lib/util";

// ---------------------------------------------------------------------------
// "A living shore": a side-view beach cross-section built from the same visual
// language as WaveHeightCard.tsx — three layered sine silhouettes scrolling on
// the shared `wavescroll`/`wavescroll-rev` keyframes — but here the FRONT
// layer's mean surface IS the tide waterline, and the water meets a concave
// sand berm so the shoreline contact travels both up AND along the beach as
// the tide moves.
// ---------------------------------------------------------------------------

// viewBox geometry. WIDTH/TILE match WaveHeightCard.tsx exactly so the water
// layers reuse its `wavescroll`/`wavescroll-rev` keyframes (a seamless loop of
// exactly WIDTH px). HEIGHT is a coordinate scale only — the SVG stretches to
// the card's CSS box (`preserveAspectRatio="none"`), so relative proportions
// are what matter, not absolute px.
const WIDTH = 400;
const HEIGHT = 170;
const TILE = WIDTH * 2;
const STEP = 5;
// Water paths close a few px BELOW the frame so the ±2px `tidebreathe`
// oscillation never exposes a background gap along the bottom edge.
const BASE_Y = HEIGHT + 6;

// Coordinates rounded to 2 decimals so the server-rendered markup and the
// client hydration pass agree exactly (same convention as WaveHeightCard.tsx
// and ScoreWheel.tsx).
const round2 = (v: number) => Math.round(v * 100) / 100;

// Sky: a thin, quiet tint fading out over roughly the top 15% of the frame.
// The card container's own bg (sky-100 / dark slate) is the open sky behind
// everything, so there's no hard band edge floating mid-air.
const SKY_H = 26;

// Vertical tide mapping: low tide parks the waterline ~75% down the card,
// high tide ~35% down — a big, unmistakable swing that the berm curve below
// is shaped to cross end-to-end.
const LOW_Y = round2(HEIGHT * 0.75); // 127.5
const HIGH_Y = round2(HEIGHT * 0.35); // 59.5
const waterlineY = (fraction: number) => round2(LOW_Y + fraction * (HIGH_Y - LOW_Y));

// ---------------------------------------------------------------------------
// The beach berm: one concave quadratic Bézier — NOT a straight diagonal —
// rising from the frame bottom left-of-center to a dry dune shoulder on the
// right edge. The control point is pulled low/right so the foreshore starts
// nearly flat (like a real beach face) and steepens into the dune. Because
// the curve spans the whole LOW_Y..HIGH_Y band, the shoreline contact slides
// ~100px horizontally as well as ~68px vertically between tides.
// ---------------------------------------------------------------------------
const BERM = { x0: 110, y0: HEIGHT, cx: 290, cy: 150, x1: WIDTH, y1: 30 };
// The sand body closes BELOW the frame (HEIGHT + 8), not at the frame edge:
// the water is painted down past the frame too (BASE_Y), so when the ±2px
// breathe shifts the sea group up, there must be sand — not water — under the
// berm's bottom edge, or a blue hairline strip flashes along the card bottom.
const SAND_D = `M${BERM.x0},${BERM.y0} Q${BERM.cx},${BERM.cy} ${BERM.x1},${BERM.y1} L${WIDTH},${HEIGHT + 8} L${BERM.x0},${HEIGHT + 8} Z`;

/**
 * x on the berm curve for a given waterline y. y(t) on a quadratic Bézier is
 * itself a quadratic in t and strictly decreasing here (bottom → dune top),
 * so the closed-form root inversion is exact — the returned x always sits on
 * the same curve SAND_D draws, so the contact math can't drift from the art.
 */
function bermXForY(y: number): number {
  const a = BERM.y0 - 2 * BERM.cy + BERM.y1;
  const b = 2 * (BERM.cy - BERM.y0);
  const c = BERM.y0 - y;
  const disc = Math.sqrt(Math.max(0, b * b - 4 * a * c));
  const t = clamp((-b - disc) / (2 * a), 0, 1);
  const xa = BERM.x0 - 2 * BERM.cx + BERM.x1;
  const xb = 2 * (BERM.cx - BERM.x0);
  return round2(BERM.x0 + xb * t + xa * t * t);
}

/** Sine surface samples along the 2x tile, as "x,y" path segments. */
function surfacePts(meanY: number, amplitude: number, wavelength: number, phaseRad: number): string {
  const pts: string[] = [];
  for (let x = 0; x <= TILE; x += STEP) {
    const y = meanY + amplitude * Math.sin((2 * Math.PI * x) / wavelength + phaseRad);
    pts.push(`${x},${round2(y)}`);
  }
  return pts.join(" L");
}

/** A filled water layer: sine top, closed below the frame. Pure trig — no
 *  Date.now()/Math.random — so SSR and first client render always agree. */
function wavePath(meanY: number, amplitude: number, wavelength: number, phaseRad: number): string {
  return `M0,${BASE_Y} L${surfacePts(meanY, amplitude, wavelength, phaseRad)} L${TILE},${BASE_Y} Z`;
}

/** The same sine as an open stroke — used for the foam line riding the front
 *  wave's edge (identical params + animation keep them in perfect sync). */
function waveLine(meanY: number, amplitude: number, wavelength: number, phaseRad: number): string {
  return `M${surfacePts(meanY, amplitude, wavelength, phaseRad)}`;
}

// Three stacked water layers, back to front. The back layers' surfaces sit a
// few px above the honest front waterline (their crests peek over it — the
// same parallax-depth trick as WaveHeightCard). Wavelengths are integer
// divisors of WIDTH so the WIDTH-long scroll loops seamlessly; amplitudes
// stay small (3-4.5px): this is lapping shore water, not surf. Speeds differ
// per layer and the mid layer runs reversed for a cross-current.
const FRONT_ANIM = "wavescroll 7s linear infinite";
const WAVES = {
  back: { off: -5, amp: 2.5, wl: WIDTH / 2, ph: 0.9, anim: "wavescroll 16s linear infinite" },
  mid: { off: -2.5, amp: 3, wl: WIDTH / 3, ph: 2.6, anim: "wavescroll-rev 11s linear infinite" },
  front: { off: 0, amp: 4, wl: WIDTH / 4, ph: 4.4, anim: FRONT_ANIM },
};

/**
 * The tide as a living shore: sky, a concave sand berm, and a three-layer
 * parallax sea whose front surface sits at the current interpolated tide
 * level. Foam and a translucent wave tongue mark the shoreline contact, a
 * damp-sand band shows how far the water reaches at high tide, and dashed
 * high/low guides calibrate the swing. The whole water group "breathes"
 * ±2px (globals.css `tidebreathe`); all motion obeys the app-wide
 * prefers-reduced-motion kill switch in globals.css.
 */
export function TideCrossSection({
  events,
  trend,
  tz,
  aberration,
}: {
  events: TideEvent[];
  trend?: "rising" | "falling";
  tz: string;
  aberration?: TideAberration;
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
  const shoreX = bermXForY(waterY);

  // Next event tick: where the water will reach at the next reported high/low,
  // on the SAME fraction scale as the current waterline. With a single known
  // event (trend-fallback) there's no honest span to interpolate against, so
  // the marker goes to the guide the turning point IS (high → the high line).
  const next = events[0];
  let nextTick: { x: number; y: number; label: string } | null = null;
  if (next && level) {
    let nextFraction: number;
    if (level.method === "trend-fallback") {
      nextFraction = next.type === "high" ? 1 : 0;
    } else {
      const span = Math.max(level.hiFt - level.loFt, 0.001);
      nextFraction = clamp((next.heightFt - level.loFt) / span, 0, 1);
    }
    const y = waterlineY(nextFraction);
    nextTick = {
      x: bermXForY(y),
      y,
      label: `${next.type === "high" ? "High" : "Low"} ${fmtTime(next.time, tz)}`,
    };
  }

  const mounted = nowMs != null;

  // "Normal tide" reference lines — drawn only on an aberrant day (nothing on a
  // normal day, so the card never gets noisier for no reason). HIGH_Y/LOW_Y are
  // exactly today's peak-high / lowest-low positions, so we calibrate an
  // absolute-height→y map on those two anchors and drop a quiet dashed line at
  // the top of the normal HIGH band (p90) and/or the bottom of the normal LOW
  // band (p10). Today's animated waterline visibly escapes past it during a
  // king tide (or an unusually low low). The lines ride over the open water,
  // left of the shoreline contact, so they never touch the sand-side guides.
  const bandLines: { y: number; x2: number; label: string; king: boolean }[] = [];
  if (aberration) {
    const hi = aberration.todayMaxHighFt;
    const lo = aberration.todayMinLowFt;
    const span = Math.max(hi - lo, 0.001);
    const yForHeight = (h: number) => waterlineY(clamp((h - lo) / span, 0, 1));
    if (aberration.highStatus !== "normal") {
      const y = yForHeight(aberration.p90HighFt);
      bandLines.push({ y, x2: bermXForY(y), label: "normal high", king: true });
    }
    if (aberration.lowStatus !== "normal") {
      const y = yForHeight(aberration.p10LowFt);
      bandLines.push({ y, x2: bermXForY(y), label: "normal low", king: false });
    }
  }

  return (
    <div className="relative mt-2 h-40 w-full overflow-hidden rounded-xl bg-sky-100 dark:bg-slate-950/50 sm:h-48">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        <defs>
          {/* Quiet high-sky tint fading down — works over both light sky-100
              and the dark navy container without a hard band edge. */}
          <linearGradient
            id="tidecs-skytint"
            x1="0"
            y1="0"
            x2="0"
            y2={SKY_H * 2}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="rgba(37, 99, 235, 0.16)" />
            <stop offset="1" stopColor="rgba(37, 99, 235, 0)" />
          </linearGradient>

          {/* Depth grade for the front layer: brightest at the surface, one
              step deeper at the bottom — one body of water, not a flat band. */}
          <linearGradient
            id="tidecs-depth"
            x1="0"
            y1={waterY}
            x2="0"
            y2={HEIGHT}
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#32a4ff" />
            <stop offset="1" stopColor="#1b85f5" />
          </linearGradient>

          {/* The sea's home: everything EXCEPT the sand body (even-odd frame
              minus berm). Water fills to full depth left of the beach and
              tapers to nothing at the shoreline contact — a true cross-
              section, which keeps the berm curve visible at every tide. */}
          <clipPath id="tidecs-sea">
            <path d={`M0,-8 H${WIDTH} V${HEIGHT + 8} H0 Z ${SAND_D}`} clipRule="evenodd" />
          </clipPath>

          {/* The sand body itself — hosts the wet-sand band + wave tongue. */}
          <clipPath id="tidecs-sand">
            <path d={SAND_D} />
          </clipPath>

          {/* Tongue window: sand at/just past today's contact. Without this
              x-limit the 35% wash would also tint dry sand deep under the
              dune (below sea level but not under water). A gradient MASK, not
              a clip: a hard clip edge read as a vertical seam on the sand.
              The mask rect is static (masks are applied in the un-animated
              group's space), so the fade stays put while the wave slides
              under it, lapping a few px up the beach face. */}
          <linearGradient
            id="tidecs-shorefade"
            x1={round2(shoreX - 30)}
            x2={round2(shoreX + 12)}
            y1="0"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#000000" />
          </linearGradient>
          <mask id="tidecs-shoremask" maskUnits="userSpaceOnUse" x={0} y={-8} width={WIDTH} height={HEIGHT + 16}>
            <rect x={0} y={-8} width={WIDTH} height={HEIGHT + 16} fill="url(#tidecs-shorefade)" />
          </mask>

          {/* Foam lives only near the contact, not across the whole sea —
              faded in from open water and out just past the tongue's reach. */}
          <linearGradient
            id="tidecs-foamfade"
            x1={round2(shoreX - 58)}
            x2={round2(shoreX + 14)}
            y1="0"
            y2="0"
            gradientUnits="userSpaceOnUse"
          >
            <stop offset="0" stopColor="#000000" />
            <stop offset="0.35" stopColor="#ffffff" />
            <stop offset="0.8" stopColor="#ffffff" />
            <stop offset="1" stopColor="#000000" />
          </linearGradient>
          <mask id="tidecs-foammask" maskUnits="userSpaceOnUse" x={0} y={-8} width={WIDTH} height={HEIGHT + 16}>
            <rect x={0} y={-8} width={WIDTH} height={HEIGHT + 16} fill="url(#tidecs-foamfade)" />
          </mask>
        </defs>

        {/* sky */}
        <rect x={0} y={0} width={WIDTH} height={SKY_H * 2} fill="url(#tidecs-skytint)" />

        {/* dry sand: the concave berm, warm in both modes */}
        <path d={SAND_D} className="fill-amber-100 dark:fill-[#4a3c26]" />

        {/* wet sand: from the current waterline up to the high-tide line —
            "the water reaches here at high tide". Shrinks to nothing as the
            tide tops out. */}
        <g clipPath="url(#tidecs-sand)">
          <rect
            x={0}
            y={HIGH_Y}
            width={WIDTH}
            height={round2(Math.max(0, waterY - HIGH_Y))}
            fill="#3d5a78"
            fillOpacity={0.2}
            className="dark:fill-[#8db6dd] dark:[fill-opacity:0.16]"
          />
        </g>

        {/* THE WATER — one breathing group (globals.css `tidebreathe`, ±2px,
            9s) so the sea feels liquid even at a glance. Inside it: the three
            parallax layers clipped to the sea region, then the tongue + foam
            at the shoreline contact. Animations start only after mount so
            SSR/hydration markup match (same discipline as the clock). */}
        <g style={mounted ? { animation: "tidebreathe 9s ease-in-out infinite alternate" } : undefined}>
          <g clipPath="url(#tidecs-sea)">
            <path
              d={wavePath(waterY + WAVES.back.off, WAVES.back.amp, WAVES.back.wl, WAVES.back.ph)}
              fill="#0b4f8f"
              style={mounted ? { animation: WAVES.back.anim } : undefined}
            />
            <path
              d={wavePath(waterY + WAVES.mid.off, WAVES.mid.amp, WAVES.mid.wl, WAVES.mid.ph)}
              fill="#1b85f5"
              style={mounted ? { animation: WAVES.mid.anim } : undefined}
            />
            <path
              d={wavePath(waterY, WAVES.front.amp, WAVES.front.wl, WAVES.front.ph)}
              fill="url(#tidecs-depth)"
              style={mounted ? { animation: FRONT_ANIM } : undefined}
            />
          </g>

          {/* wave tongue: the front wave again, washed over the submerged
              sand and lapping a few px past the contact — same path + same
              animation keeps it phase-locked with the real front layer. */}
          <g clipPath="url(#tidecs-sand)" mask="url(#tidecs-shoremask)">
            <path
              d={wavePath(waterY, WAVES.front.amp, WAVES.front.wl, WAVES.front.ph)}
              fill="#32a4ff"
              fillOpacity={0.35}
              style={mounted ? { animation: FRONT_ANIM } : undefined}
            />
          </g>

          {/* foam line riding the front wave's edge at the contact */}
          <g mask="url(#tidecs-foammask)">
            <path
              d={waveLine(waterY, WAVES.front.amp, WAVES.front.wl, WAVES.front.ph)}
              fill="none"
              stroke="#ffffff"
              strokeOpacity={0.6}
              strokeWidth={1.6}
              style={mounted ? { animation: FRONT_ANIM } : undefined}
            />
          </g>
        </g>

        {/* High/low waterline guides, sand side only (right of the berm at
            each height, where nothing else is ever drawn). Tiny haloed
            labels tuck under each line at the right edge, over sand at any
            tide. Static, honest positions — they do NOT breathe. */}
        {(
          [
            { y: HIGH_Y, label: "high" },
            { y: LOW_Y, label: "low" },
          ] as const
        ).map((g) => (
          <g key={g.label}>
            <line
              x1={bermXForY(g.y)}
              x2={WIDTH}
              y1={g.y}
              y2={g.y}
              stroke="#0f172a"
              strokeOpacity={0.35}
              strokeWidth={1}
              strokeDasharray="4 3"
              className="dark:stroke-white/40"
            />
            <text
              x={WIDTH - 5}
              y={g.y + 9}
              textAnchor="end"
              fontSize={8.5}
              fontWeight={700}
              letterSpacing={0.4}
              fill="#0f172a"
              fillOpacity={0.75}
              stroke="#ffffff"
              strokeWidth={2.5}
              strokeLinejoin="round"
              paintOrder="stroke"
              className="dark:fill-white dark:stroke-slate-950"
            >
              {g.label}
            </text>
          </g>
        ))}

        {/* "Normal tide" band references — quiet dashed lines over open water,
            only present on an aberrant day. Amber for the king-tide high (it can
            flood A1A + parking), cyan for the unusually low low. Static + honest;
            they do NOT breathe. Today's live waterline escapes past them. */}
        {bandLines.map((b) => (
          <g key={b.label}>
            <line
              x1={6}
              x2={round2(Math.max(b.x2 - 4, 40))}
              y1={b.y}
              y2={b.y}
              stroke={b.king ? "#d97706" : "#0891b2"}
              strokeOpacity={0.55}
              strokeWidth={1.25}
              strokeDasharray="3 3"
            />
            <text
              x={8}
              y={round2(clamp(b.y - 4, 10, HEIGHT - 4))}
              textAnchor="start"
              fontSize={8}
              fontWeight={700}
              letterSpacing={0.3}
              stroke="#ffffff"
              strokeWidth={2.25}
              strokeLinejoin="round"
              paintOrder="stroke"
              className={
                b.king
                  ? "fill-amber-700 dark:fill-amber-300 dark:stroke-slate-950"
                  : "fill-cyan-700 dark:fill-cyan-300 dark:stroke-slate-950"
              }
            >
              {b.label}
            </text>
          </g>
        ))}

        {/* Next high/low: a solid tick at ITS waterline on the berm, label to
            the LEFT over open water/sky — the guide labels own the right
            edge, so the two can never collide. This is the ONLY text beyond
            the tiny guide labels: the rising/falling trend is shown once, in
            the card header (TidePanel.tsx), never in the SVG — that
            duplication was the old collision bug; do not regress it. */}
        {nextTick ? (
          <g>
            <line
              x1={nextTick.x}
              y1={round2(nextTick.y - 7)}
              x2={nextTick.x}
              y2={round2(nextTick.y + 7)}
              stroke="#0f172a"
              strokeOpacity={0.55}
              strokeWidth={1.5}
              className="dark:stroke-white/60"
            />
            <text
              x={round2(nextTick.x - 8)}
              y={round2(clamp(nextTick.y + 3.5, 12, HEIGHT - 6))}
              textAnchor="end"
              fontSize={11}
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
