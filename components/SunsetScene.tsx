import { skyTier, type SkyTier, type SunScenePhase } from "@/lib/sunsetScene";

// ---------------------------------------------------------------------------
// "The predicted sky": a wide, short horizon scene for the Golden hour card.
// Same idiom as TideCrossSection.tsx / WaveHeightCard.tsx — one viewBox-scaled
// inline SVG, `preserveAspectRatio="none"`, every coordinate a constant or a
// round2'd expression, nothing measured from the DOM, nothing random. Pure
// props → identical markup on the server and at hydration.
//
// The point of the graphic is that THE SKY IS THE FORECAST: the gradient is
// keyed to the color score, and the clouds are the ACTUAL forecast mix — so a
// heavy low deck is drawn as a dark band sitting on the horizon, visibly
// blocking the sun. That's honest: low cloud is exactly what kills the show.
// ---------------------------------------------------------------------------

const WIDTH = 280;
const HEIGHT = 64;
/** Horizon in the lower third: sky above, a shallow sea below. */
const HORIZON = 42;
/** The sun's column. Off-center so the scene isn't a symmetrical logo. */
const SUN_X = 196;

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Sky gradient stops, top → horizon, per palette tier. */
const SKY: Record<SkyTier, readonly { off: number; c: string }[]> = {
  vivid: [
    { off: 0, c: "#4c1d95" },
    { off: 0.42, c: "#f43f5e" },
    { off: 0.78, c: "#fb923c" },
    { off: 1, c: "#fde047" },
  ],
  warm: [
    { off: 0, c: "#6b7fa8" },
    { off: 0.48, c: "#f9a8d4" },
    { off: 1, c: "#fcd34d" },
  ],
  mild: [
    { off: 0, c: "#64748b" },
    { off: 0.55, c: "#a3aebe" },
    { off: 1, c: "#fde68a" },
  ],
  dud: [
    { off: 0, c: "#5b6b80" },
    { off: 0.6, c: "#8896a8" },
    { off: 1, c: "#aab5c2" },
  ],
  unknown: [
    { off: 0, c: "#94a3b8" },
    { off: 1, c: "#cbd5e1" },
  ],
};

/** Deep, quiet night sky — used whenever the phase says the sun is long gone,
 *  regardless of how good the NEXT event's score is. */
const NIGHT_SKY: readonly { off: number; c: string }[] = [
  { off: 0, c: "#020617" },
  { off: 0.6, c: "#0f172a" },
  { off: 1, c: "#1e293b" },
];

/** Sea tones (surface → depth), tinted by what the sky above is doing. */
const SEA: Record<SkyTier, readonly [string, string]> = {
  vivid: ["#8a4a5e", "#2b1b3d"],
  warm: ["#7d6a86", "#2f2a45"],
  mild: ["#5f7185", "#2c3a4c"],
  dud: ["#61707f", "#333e4a"],
  unknown: ["#94a3b8", "#64748b"],
};
const NIGHT_SEA: readonly [string, string] = ["#0b1220", "#020617"];

/** Sun disc geometry per phase. `null` = no disc drawn at all. */
const SUN_POS: Record<SunScenePhase, { cy: number; r: number } | null> = {
  day: { cy: 13, r: 4 },
  before: { cy: 25, r: 6.5 },
  // Sitting exactly ON the horizon: the sea is painted after the disc, so the
  // bottom half is submerged — a half-set sun, no clipping math required.
  golden: { cy: HORIZON, r: 7.5 },
  afterglow: null,
  night: null,
};

/** Where the halo sits when there's no disc (afterglow: glow arc only). */
const AFTERGLOW_GLOW_Y = 45;

/** Fixed star field for the night sky — three motes, no more. */
const STARS: readonly { x: number; y: number; r: number }[] = [
  { x: 44, y: 11, r: 0.9 },
  { x: 122, y: 6, r: 0.7 },
  { x: 232, y: 15, r: 0.8 },
];

/** High cirrus: thin streaks near the top of the frame. */
const HIGH_STREAKS: readonly { x: number; y: number; w: number; h: number }[] = [
  { x: 22, y: 8, w: 78, h: 1.8 },
  { x: 128, y: 5, w: 62, h: 1.4 },
  { x: 186, y: 12, w: 68, h: 1.6 },
];

/** Mid-deck puffs — the color canvas. Each is three overlapping lobes. */
const MID_PUFFS: readonly { cx: number; cy: number; s: number }[] = [
  { cx: 52, cy: 24, s: 1 },
  { cx: 228, cy: 27, s: 1.1 },
  { cx: 142, cy: 19, s: 0.85 },
];

/** The low deck: one flat, lumpy silhouette lying on the horizon. */
const LOW_BAND_D =
  `M0,${HORIZON} L0,36 Q20,31 42,34 Q64,37 88,33 Q112,29 140,33 ` +
  `Q168,37 196,32 Q224,28 252,33 Q268,36 ${WIDTH},34 L${WIDTH},${HORIZON} Z`;

export interface SunsetSceneProps {
  /** 0-100 color score for the next sun event; null when there's no forecast. */
  score: number | null;
  /** The score's band name. Carried for parity with the card's other props; the
   *  scene keys its palette off the score itself so the two can't disagree. */
  band?: string | null;
  /** True solar elevation right now, if it's ever wired up — the phase the
   *  caller passes should already account for it. */
  sunElevationDeg?: number | null;
  /** Where the sun is in its arc (see lib/sunsetScene.ts's sunScenePhase). */
  phase: SunScenePhase;
  /** The forecast cloud mix for the event hour — drawn literally. */
  cloud?: {
    lowPct?: number | null;
    midPct?: number | null;
    highPct?: number | null;
    totalPct?: number | null;
  } | null;
}

/**
 * A ~280×64 horizon scene: sky gradient keyed to the color score, a sun placed
 * by phase, the real forecast cloud mix as silhouettes, and a two-tone sea.
 * Decorative only (`aria-hidden`) — the card's own text stays the accessible
 * reading. Height is fixed by the caller's well so the tile never grows.
 */
export function SunsetScene({ score, phase, cloud }: SunsetSceneProps) {
  const isNight = phase === "night";
  const tier = skyTier(score);
  const skyStops = isNight ? NIGHT_SKY : SKY[tier];
  const [seaTop, seaDeep] = isNight ? NIGHT_SEA : SEA[tier];
  const sun = SUN_POS[phase];

  // Glow strength follows the forecast: a dud sky gets a wan smudge, an epic
  // one gets a real bloom. Unknown score → a flat, uncommitted glow.
  const glowStrength = score == null ? 0.18 : round2(0.2 + (Math.min(100, Math.max(0, score)) / 100) * 0.6);
  const glowY = sun ? sun.cy : AFTERGLOW_GLOW_Y;
  const showGlow = !isNight && (sun != null || phase === "afterglow");

  // Cloud tiers. A complete low/mid/high split is drawn literally; with only a
  // total we can't say WHICH deck it is, so one generic puff tier stands in
  // rather than inventing a low band that would fake a blocked horizon.
  const hasSplit = cloud?.lowPct != null || cloud?.midPct != null || cloud?.highPct != null;
  const lowPct = hasSplit ? (cloud?.lowPct ?? 0) : 0;
  const midPct = hasSplit ? (cloud?.midPct ?? 0) : (cloud?.totalPct ?? 0);
  const highPct = hasSplit ? (cloud?.highPct ?? 0) : 0;

  const showLowBand = lowPct >= 40;
  const lowOpacity = showLowBand ? round2(Math.min(0.85, 0.45 + ((lowPct - 40) / 60) * 0.4)) : 0;
  const midCount = midPct >= 50 ? 3 : midPct >= 25 ? 2 : 0;
  const highCount = highPct >= 35 ? 3 : highPct >= 15 ? 2 : 0;

  // Sun glitter on the water: only when there IS a sun and the horizon isn't
  // walled off by a low deck.
  const showGlitter = !isNight && phase !== "afterglow" && !showLowBand && score != null;

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className="absolute inset-0 h-full w-full"
      aria-hidden
    >
      <defs>
        <linearGradient id="sunscene-sky" x1="0" y1="0" x2="0" y2={HORIZON} gradientUnits="userSpaceOnUse">
          {skyStops.map((s) => (
            <stop key={s.off} offset={s.off} stopColor={s.c} />
          ))}
        </linearGradient>
        <linearGradient id="sunscene-sea" x1="0" y1={HORIZON} x2="0" y2={HEIGHT} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={seaTop} />
          <stop offset="1" stopColor={seaDeep} />
        </linearGradient>
        {/* Sun bloom — a soft radial that the low-cloud band is drawn OVER, so
            a blocked horizon reads as a blocked horizon. */}
        <radialGradient id="sunscene-glow" cx={SUN_X} cy={glowY} r={34} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff2c4" stopOpacity={glowStrength} />
          <stop offset="0.45" stopColor="#fdba74" stopOpacity={round2(glowStrength * 0.55)} />
          <stop offset="1" stopColor="#fb923c" stopOpacity={0} />
        </radialGradient>
        <linearGradient id="sunscene-glitter" x1="0" y1={HORIZON} x2="0" y2={HEIGHT} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.34} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </linearGradient>
      </defs>

      {/* sky */}
      <rect x={0} y={0} width={WIDTH} height={HORIZON} fill="url(#sunscene-sky)" />

      {/* night: a few quiet stars instead of a sun */}
      {isNight
        ? STARS.map((s) => (
            <circle key={s.x} cx={s.x} cy={s.y} r={s.r} fill="#e2e8f0" fillOpacity={0.75} />
          ))
        : null}

      {/* high cirrus — thin, backlit streaks up top */}
      {HIGH_STREAKS.slice(0, highCount).map((s) => (
        <rect
          key={s.x}
          x={s.x}
          y={s.y}
          width={s.w}
          height={s.h}
          rx={s.h / 2}
          fill="#ffffff"
          fillOpacity={isNight ? 0.18 : 0.5}
        />
      ))}

      {/* the sun: bloom first, then the disc (absent in afterglow/night) */}
      {showGlow ? <rect x={0} y={0} width={WIDTH} height={HORIZON} fill="url(#sunscene-glow)" /> : null}
      {sun ? <circle cx={SUN_X} cy={sun.cy} r={sun.r} fill="#fff6d8" fillOpacity={0.95} /> : null}

      {/* mid deck — the canvas the low sun paints on. Drawn over the sun so a
          thick deck genuinely covers it. */}
      {MID_PUFFS.slice(0, midCount).map((p) => (
        <g key={p.cx} fill="#e8edf4" fillOpacity={isNight ? 0.22 : 0.72}>
          <ellipse cx={round2(p.cx - 9 * p.s)} cy={round2(p.cy + 1.5)} rx={round2(8 * p.s)} ry={round2(4 * p.s)} />
          <ellipse cx={p.cx} cy={p.cy} rx={round2(11 * p.s)} ry={round2(5.5 * p.s)} />
          <ellipse cx={round2(p.cx + 10 * p.s)} cy={round2(p.cy + 2)} rx={round2(7.5 * p.s)} ry={round2(3.8 * p.s)} />
        </g>
      ))}

      {/* the low deck: a dark silhouette lying ON the horizon, painted over the
          sun and its bloom. This is the honest part — heavy low cloud blocks
          the beam before it ever reaches the canvas above. */}
      {showLowBand ? <path d={LOW_BAND_D} fill="#1e293b" fillOpacity={lowOpacity} /> : null}

      {/* sea — drawn last over the sky, so a sun at HORIZON is half-submerged */}
      <rect x={0} y={HORIZON} width={WIDTH} height={HEIGHT - HORIZON} fill="url(#sunscene-sea)" />
      <line
        x1={0}
        x2={WIDTH}
        y1={HORIZON}
        y2={HORIZON}
        stroke="#ffffff"
        strokeOpacity={isNight ? 0.14 : 0.32}
        strokeWidth={0.8}
      />

      {/* the sun's road on the water */}
      {showGlitter ? (
        <path
          d={`M${SUN_X - 4},${HORIZON} L${SUN_X + 4},${HORIZON} L${SUN_X + 15},${HEIGHT} L${SUN_X - 15},${HEIGHT} Z`}
          fill="url(#sunscene-glitter)"
        />
      ) : null}

      {/* no score: a plain neutral sky plus an em-dash mark, so the tile reads
          "we don't know" rather than "we predict a gray evening". Drawn as a
          rect, not text — the scene stretches horizontally, and glyphs would
          distort with it. */}
      {score == null && !isNight ? (
        <rect x={134} y={20} width={12} height={1.8} rx={0.9} fill="#ffffff" fillOpacity={0.8} />
      ) : null}

      {/* Dark mode: one quiet deepening pass over the whole scene rather than a
          second palette — a sunset looks like a sunset in either theme, it just
          shouldn't glare out of a dark card. */}
      <rect
        x={0}
        y={0}
        width={WIDTH}
        height={HEIGHT}
        fill="#020617"
        fillOpacity={0}
        className="dark:[fill-opacity:0.18]"
      />
    </svg>
  );
}
