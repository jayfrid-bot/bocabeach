import { clarityHazeOpacity, clarityParticles } from "@/lib/clarityScene";

// ---------------------------------------------------------------------------
// "Can you see the bottom": a swimmer's-eye water column for the Water clarity
// tile. Same idiom as TideCrossSection.tsx / WaveHeightCard.tsx — one
// viewBox-scaled inline SVG, `preserveAspectRatio="none"`, constant geometry,
// no DOM measuring, no randomness (the particle field comes from a van der
// Corput sequence in lib/clarityScene.ts). Pure props → identical markup on
// the server and at hydration.
//
// The claim the graphic makes: CLARITY IS VISIBILITY. The fish and the sand
// line are always drawn at full strength; what changes with the reading is how
// much turbidity haze and suspended junk sits between you and them.
// ---------------------------------------------------------------------------

const WIDTH = 280;
const HEIGHT = 56;

/** The seafloor silhouette — a lumpy sand line closing to the frame bottom. */
const SAND_D =
  `M0,48 Q30,44 62,47 Q94,50 128,46 Q162,42 196,47 Q230,51 258,46 ` +
  `Q270,44 ${WIDTH},46 L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;
/** The same line as an open stroke, so the floor has a crisp edge in clear water. */
const SAND_LINE_D = `M0,48 Q30,44 62,47 Q94,50 128,46 Q162,42 196,47 Q230,51 258,46 Q270,44 ${WIDTH},46`;

/** A quiet ripple for the surface, near the top of the frame. */
const SURFACE_D = `M0,4 Q35,2 70,4 T140,4 T210,4 T${WIDTH},4`;

/** Ripple/shell texture flecks on the sand — fixed, so they never dance. */
const SAND_FLECKS: readonly { x: number; y: number; w: number }[] = [
  { x: 18, y: 51, w: 7 },
  { x: 52, y: 53, w: 5 },
  { x: 96, y: 50, w: 8 },
  { x: 148, y: 52, w: 6 },
  { x: 196, y: 51, w: 7 },
  { x: 238, y: 53, w: 5 },
];

/** The lone fish, mid-water. One ellipse body + a wedge tail — a silhouette,
 *  not an illustration; at low clarity the haze reduces it to a shadow. */
const FISH = { cx: 168, cy: 26 };

export interface ClaritySceneProps {
  /** 0-100 clarity (100 = crystal clear). Null renders nothing at all: the
   *  tile's own text already says honestly that there's no reading. */
  pct: number | null;
  /** The clarity grade word. Carried for parity with the tile; the scene keys
   *  off pct so the picture and the percentage can never disagree. */
  level?: string | null;
}

/**
 * A ~280×56 side-view water column: blue-green water, a sand floor, one fish,
 * and a turbidity haze whose opacity is the inverse of the clarity reading.
 * Decorative only (`aria-hidden`) — the tile's text stays the accessible
 * reading. Height is fixed by the caller's well so the tile never grows.
 */
export function ClarityScene({ pct }: ClaritySceneProps) {
  if (pct == null || !Number.isFinite(pct)) return null;

  const haze = clarityHazeOpacity(pct);
  const particles = clarityParticles(pct, WIDTH, HEIGHT);

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id="clarity-water" x1="0" y1="0" x2="0" y2={HEIGHT} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4fc3d9" />
          <stop offset="0.55" stopColor="#1f8fa8" />
          <stop offset="1" stopColor="#0d5f74" />
        </linearGradient>
        {/* Turbidity: sandy-brown suspended near the surface grading to a
            tea-colored gloom at depth, where the light has already gone. */}
        <linearGradient id="clarity-haze" x1="0" y1="0" x2="0" y2={HEIGHT} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#c2a26a" />
          <stop offset="1" stopColor="#6f5c33" />
        </linearGradient>
      </defs>

      {/* the water column */}
      <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="url(#clarity-water)" />

      {/* surface: a single lighter line, so the scene reads as "under water,
          looking sideways" rather than a flat swatch */}
      <path d={SURFACE_D} fill="none" stroke="#ffffff" strokeOpacity={0.45} strokeWidth={1} />

      {/* seafloor + its texture */}
      <path d={SAND_D} fill="#e0c48c" className="dark:fill-[#9a8054]" />
      <path d={SAND_LINE_D} fill="none" stroke="#c9a86a" strokeOpacity={0.9} strokeWidth={1} />
      {SAND_FLECKS.map((f) => (
        <rect key={f.x} x={f.x} y={f.y} width={f.w} height={1.1} rx={0.55} fill="#b8945a" fillOpacity={0.7} />
      ))}

      {/* the fish */}
      <g fill="#123c4b" fillOpacity={0.8} className="dark:fill-[#0a2731]">
        <ellipse cx={FISH.cx} cy={FISH.cy} rx={7.5} ry={3.2} />
        <path
          d={`M${FISH.cx + 6},${FISH.cy} L${FISH.cx + 13},${FISH.cy - 3.4} L${FISH.cx + 13},${FISH.cy + 3.4} Z`}
        />
        <circle cx={FISH.cx - 4.4} cy={FISH.cy - 0.8} r={0.75} fill="#e6f4f8" fillOpacity={0.85} />
      </g>

      {/* THE READING: haze between the eye and everything above. At 100% clear
          it's a whisper (0.05); in churned water it swallows the sand line and
          leaves the fish as a shadow (0.75). */}
      <rect x={0} y={0} width={WIDTH} height={HEIGHT} fill="url(#clarity-haze)" fillOpacity={haze} />

      {/* suspended particles ride in FRONT of the haze — they're the stuff
          floating right at your mask, and they multiply as clarity drops */}
      {particles.map((p) => (
        <circle key={`${p.x}-${p.y}`} cx={p.x} cy={p.y} r={p.r} fill="#f8f4e6" fillOpacity={p.o} />
      ))}

      {/* Dark mode: deepen the water without touching the haze's legibility. */}
      <rect
        x={0}
        y={0}
        width={WIDTH}
        height={HEIGHT}
        fill="#020617"
        fillOpacity={0}
        className="dark:[fill-opacity:0.22]"
      />
    </svg>
  );
}

/**
 * The Water clarity tile's front face. This is MetricCard's exact layout with
 * the scene dropped into the value block — the scene lives in the tile's dead
 * vertical space, and the sub line is compacted to one line (full text kept in
 * `title`) so the tile's height is unchanged versus MetricCard's 3-line sub.
 * With no reading (`pct == null`) there's no scene and the sub keeps its full
 * 3-line allowance, exactly as before.
 */
export function ClarityTileFront({
  value,
  sub,
  subShort,
  pct,
  level,
  muted = false,
}: {
  value: string;
  sub: string;
  /** Shorter phone-width sub (see clarityTileCopy); falls back to `sub`. */
  subShort?: string;
  pct: number | null;
  level?: string | null;
  /** The scene is showing a REMEMBERED day (the overnight fallback), not a live
   *  read — draw it dimmed and desaturated so it never reads as "right now". */
  muted?: boolean;
}) {
  const hasScene = pct != null && Number.isFinite(pct);

  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🔍</span>
        <span className="truncate">Water clarity</span>
      </div>
      <div className="flex flex-1 flex-col justify-center">
        <div
          className={`text-xl font-semibold tabular-nums sm:text-2xl ${
            muted ? "text-slate-500 dark:text-slate-400" : "text-slate-900 dark:text-white"
          }`}
        >
          {value}
        </div>
        {hasScene ? (
          // Radius stays well inside the card's rounded-2xl (concentric).
          <div
            className={`relative mt-1 h-7 w-full overflow-hidden rounded-lg sm:h-8 ${
              muted ? "opacity-50 saturate-50" : ""
            }`}
          >
            <ClarityScene pct={pct} level={level} />
          </div>
        ) : null}
        <div
          // NOTE: unlike SunQualityCard's colorLine (same clamp idiom), this
          // line swaps in MORE text at sm+ (the full `sub`, including the
          // free-text cam note) than it shows on phones (`subShort`, the
          // deterministic parts only) — so it must never drop to FEWER lines
          // at the wider breakpoint. A stray `sm:line-clamp-1` here once
          // clipped the long note mid-sentence on tablet/desktop (caught by
          // e2e/layout.spec.ts); line-clamp-3 unconditionally is the safe
          // superset for both the short (mobile) and long (sm+) text.
          className="min-h-4 break-words text-xs text-slate-600 dark:text-slate-400 line-clamp-3"
          title={sub}
        >
          {subShort && subShort !== sub ? (
            <>
              <span className="sm:hidden">{subShort}</span>
              <span className="hidden sm:inline">{sub}</span>
            </>
          ) : (
            sub || " "
          )}
        </div>
      </div>
    </div>
  );
}
