import type { SargassumData } from "@/lib/types";
import {
  SEAWEED_LEVEL_FALLBACK_PCT,
  STRIP_H,
  STRIP_W,
  WATERLINE_Y,
  WET_SAND_BOTTOM_Y,
  wrackLayout,
} from "@/lib/seaweedClumps";

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

// ---------------------------------------------------------------------------
// Hand-authored clump silhouettes (local coords, centered on 0,0 — wider than
// tall, ~36-46px across at scale 1). Each variant is a "pile of weed": a
// bumpy-topped mound of overlapping rounded lobes, a darker underside shadow
// lobe hugging its bottom (depth), and a few short curved strands poking out
// (rendered as round-capped strokes). Static path strings — nothing computed
// at render — so SSR/client hydration always agree.
// ---------------------------------------------------------------------------

interface ClumpVariant {
  body: string;
  shadow: string;
  strands: string;
}

const CLUMP_VARIANTS: ClumpVariant[] = [
  // Variant 0: four-lobed mound, tallest just left of center.
  {
    body: "M-18,3 C-19,-1 -14,-6 -9,-5 C-7,-9 -1,-10 1,-6 C4,-9 9,-7 10,-3 C14,-4 18,-1 17,3 C12,7 4,8 0,7 C-6,8 -14,7 -18,3 Z",
    shadow: "M-15,3 C-9,1 9,1 15,3 C10,8 -8,8 -15,3 Z",
    strands:
      "M-13,-4 C-16,-8 -15,-11 -18,-13 M6,-6 C8,-10 12,-11 13,-15 M15,1 C19,0 22,2 24,1",
  },
  // Variant 1: chunkier three-lobed heap, higher dome.
  {
    body: "M-16,4 C-18,0 -13,-7 -7,-6 C-5,-10 3,-11 6,-7 C11,-8 16,-3 15,2 C12,7 5,8 0,7 C-7,9 -13,8 -16,4 Z",
    shadow: "M-13,4 C-7,2 8,2 13,3 C8,8 -7,9 -13,4 Z",
    strands:
      "M-10,-6 C-12,-10 -10,-13 -13,-15 M11,-5 C14,-8 18,-8 20,-11 M-16,1 C-20,0 -22,2 -25,1",
  },
  // Variant 2: low drift-line scatter, five small lobes, widest and flattest.
  {
    body: "M-19,2 C-20,-2 -15,-4 -11,-3 C-9,-6 -4,-7 -2,-4 C1,-7 6,-6 7,-3 C10,-5 15,-4 17,-1 C19,1 18,4 15,5 C8,7 -8,7 -15,6 C-18,6 -19,4 -19,2 Z",
    shadow: "M-16,3 C-9,1 10,0 16,2 C10,6 -9,7 -16,3 Z",
    strands:
      "M-15,-2 C-18,-5 -17,-8 -20,-9 M3,-5 C4,-8 8,-9 8,-13 M18,0 C22,-2 24,1 27,0",
  },
];

// Body tones (olive / brown / khaki) + one shared underside shadow. Dark-mode
// fills are lightened so the clumps stay legible on the dark sand.
const TONE_BODY = [
  "fill-[#6b7250] dark:fill-[#79815a]",
  "fill-[#8b6f47] dark:fill-[#96794e]",
  "fill-[#7a7048] dark:fill-[#847b52]",
];
const TONE_STRAND = [
  "stroke-[#5a6142] dark:stroke-[#8c9468]",
  "stroke-[#75593a] dark:stroke-[#ab8b5e]",
  "stroke-[#665d3c] dark:stroke-[#988e60]",
];
const SHADOW_FILL = "fill-[#4d5238] dark:fill-[#15170e]";

// ---------------------------------------------------------------------------
// Static scene paths (module constants — computed once, deterministic).
// ---------------------------------------------------------------------------

const round1 = (v: number) => Math.round(v * 10) / 10;

/** The scalloped foam edge: a soft sine around WATERLINE_Y. */
const FOAM_AMP = 1.8;
const FOAM_LEN = 52;
const foamY = (x: number) => WATERLINE_Y + FOAM_AMP * Math.sin((2 * Math.PI * x) / FOAM_LEN);

const foamPts: string[] = [];
for (let x = 0; x <= STRIP_W; x += 8) {
  foamPts.push(`${x},${round1(foamY(x))}`);
}
/** Open polyline along the foam edge (stroked white). */
const FOAM_LINE = `M${foamPts.join(" L")}`;
/** Water body: full-width sheet from the top down to the foam edge. */
const WATER_BODY = `M0,0 L${STRIP_W},0 L${foamPts.slice().reverse().join(" L")} Z`;
/** Wet sand: from the foam edge down to a straight lower boundary. */
const WET_SAND = `M${foamPts.join(" L")} L${STRIP_W},${WET_SAND_BOTTOM_Y} L0,${WET_SAND_BOTTOM_Y} Z`;

/** Tiny deterministic speckles on the dry sand for texture. */
const SPECKLES: { x: number; y: number }[] = [
  { x: 58, y: 52 },
  { x: 186, y: 57 },
  { x: 331, y: 54 },
];

/**
 * Seaweed (sargassum) card: the cam's-eye view. An aerial slice of beach —
 * water along the top behind a scalloped foam edge, a strip of wet sand, then
 * seaweed clumps piled along a gently wavy WRACK LINE parallel to the water
 * (exactly what the AI cam captions describe: "dense sargassum band along the
 * water's edge"), and warm dry sand below. The live coveragePct — the same
 * number that drives the score's sliding ceiling (applyBeachCaps in
 * lib/score.ts) — controls the DENSITY and THICKNESS of that band, spread
 * across the FULL width (see lib/seaweedClumps.ts for why never left-packed).
 * Everything is deterministic/seeded so SSR and client render identically —
 * and the scene is static on purpose: this card shouldn't compete with the
 * animated wave/tide cards. When only a category level is known (no measured
 * %), shows that level's representative coverage and says it's approximate.
 * Renders nothing without any seaweed data.
 */
export function SeaweedStrip({ seaweed }: { seaweed?: SargassumData | null }) {
  if (!seaweed || seaweed.level === "unknown") return null;

  const hasMeasured = typeof seaweed.coveragePct === "number" && Number.isFinite(seaweed.coveragePct);
  const coveragePct = hasMeasured
    ? (seaweed.coveragePct as number)
    : (SEAWEED_LEVEL_FALLBACK_PCT[seaweed.level] ?? 0);

  const stamps = wrackLayout(coveragePct);

  return (
    <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🪸</span>
        <span>Seaweed (sargassum)</span>
      </div>
      <div className="mt-1 text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
        {cap(seaweed.level)}
      </div>

      <div className="relative mt-2 h-14 w-full overflow-hidden rounded-xl sm:h-16">
        <svg
          viewBox={`0 0 ${STRIP_W} ${STRIP_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden
        >
          {/* Dry sand: the whole scene's base. */}
          <rect x={0} y={0} width={STRIP_W} height={STRIP_H} className="fill-[#eeddb0] dark:fill-[#2e2618]" />
          {/* Speckle texture on the dry sand. */}
          {SPECKLES.map((s, i) => (
            <circle
              key={i}
              cx={s.x}
              cy={s.y}
              r={0.9}
              opacity={0.7}
              className="fill-[#c9ab74] dark:fill-[#4a3c26]"
            />
          ))}
          {/* Wet sand strip under the waterline. */}
          <path d={WET_SAND} className="fill-[#d3b98a] dark:fill-[#3d3220]" />
          {/* Water: deeper tone at the top, shallow tone meeting the foam. */}
          <path d={WATER_BODY} className="fill-[#7cc4ee] dark:fill-[#1d4b74]" />
          <rect x={0} y={0} width={STRIP_W} height={7} className="fill-[#4ba7dd] dark:fill-[#173c5e]" />
          {/* Foam: a soft white scalloped edge, echoed fainter just below. */}
          <path
            d={FOAM_LINE}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            opacity={0.9}
            className="stroke-white dark:stroke-[#cfe8f7]"
          />
          <path
            d={FOAM_LINE}
            fill="none"
            strokeWidth={1.2}
            transform="translate(0 2.4)"
            opacity={0.35}
            className="stroke-white dark:stroke-[#cfe8f7]"
          />

          {/* The wrack line: seeded clump stamps, painted back-to-front. */}
          {stamps.map((s) => {
            const v = CLUMP_VARIANTS[s.variant];
            const sx = s.flip ? -s.scale : s.scale;
            return (
              <g key={s.key} transform={`translate(${s.x} ${s.y}) scale(${sx} ${s.scale})`}>
                <path d={v.shadow} transform="translate(0 1.6)" opacity={0.85} className={SHADOW_FILL} />
                <path d={v.body} className={TONE_BODY[s.tone]} />
                <path
                  d={v.strands}
                  fill="none"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  opacity={0.9}
                  className={TONE_STRAND[s.tone]}
                />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
        {hasMeasured
          ? `~${Math.round(coveragePct)}% covered`
          : `~${Math.round(coveragePct)}% covered (approximate, from the ${seaweed.level} category)`}
        {seaweed.isMorning ? " · 📷 AM cams (pre-clean)" : " · 📷 cams"}
        {seaweed.note ? ` — ${seaweed.note}` : ""}
      </div>
    </div>
  );
}
