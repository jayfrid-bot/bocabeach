import { seaState } from "@/lib/format";
import { clamp } from "@/lib/util";

// viewBox geometry for the animated background. WIDTH is exactly the distance
// the seamless loop travels each cycle (see globals.css `wavescroll`); TILE is
// twice that so the pattern can scroll a full WIDTH and land back on an
// identical frame. WAVELENGTH is fixed (not height-dependent) so the loop
// distance always matches WIDTH regardless of wave size — steepness instead
// comes from amplitude growing relative to a constant wavelength.
const WIDTH = 400;
const HEIGHT = 120;
const TILE = WIDTH * 2;
const WAVELENGTH = WIDTH / 2;
const STEP = 10;

// Coordinates rounded to 2 decimals so the server-rendered path and the
// client hydration pass agree exactly (raw float trig can differ in the last
// digit between the two — see the same convention in ScoreWheel.tsx).
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * One layer of the wave background: a filled silhouette running from the
 * sine curve down to the bottom of the card, tiled twice so it can scroll by
 * exactly WIDTH and loop seamlessly. Pure trig — no Date.now()/Math.random —
 * so the SSR and first client render always agree.
 */
function wavePath(amplitude: number, baseline: number, phaseRad: number): string {
  const pts: string[] = [];
  for (let x = 0; x <= TILE; x += STEP) {
    const y = baseline + amplitude * Math.sin((2 * Math.PI * x) / WAVELENGTH + phaseRad);
    pts.push(`${x},${round2(y)}`);
  }
  return `M0,${HEIGHT} L${pts.join(" L")} L${TILE},${HEIGHT} Z`;
}

interface WaveLayer {
  path: string;
  fill: string;
  opacity: number;
  durationS: number;
  reverse?: boolean;
}

/**
 * Animated wave-height card: an SVG "ocean" whose amplitude and steepness
 * visibly scale with the live wave height, plus the numeric reading and the
 * seaState label. Renders nothing when no reading is available.
 */
export function WaveHeightCard({
  waveHeightFt,
  swellPeriodS,
}: {
  waveHeightFt?: number;
  /** Optional extra context (dominant swell period, seconds) — shown if given. */
  swellPeriodS?: number;
}) {
  if (waveHeightFt == null) return null;

  const state = seaState(waveHeightFt);

  // Amplitude: 0-1ft → gentle ripple, 2-3ft → clear rolling waves, 5ft+ → big,
  // steep surf filling the card. Clamp the mapping input so freak readings
  // don't blow the SVG out; the numeric label still shows the true value.
  const ft = clamp(waveHeightFt, 0, 6);
  const amplitude = 6 + ft * 7; // 6 (flat) .. 48 (near max, big & steep)

  // Motion speed: gentle swells drift slowly, big surf scrolls noticeably
  // faster. The reduced-motion media query in globals.css freezes all of
  // this to a single static frame for users who opt out.
  const duration = clamp(15 - ft * 1.6, 5, 15);

  const layers: WaveLayer[] = [
    {
      path: wavePath(amplitude * 0.5, 56, 0.6),
      fill: "rgba(142, 216, 255, 0.35)", // ocean-300, faint — furthest back
      opacity: 1,
      durationS: duration * 1.35,
    },
    {
      path: wavePath(amplitude * 0.75, 76, 2.4),
      fill: "rgba(89, 193, 255, 0.55)", // ocean-400
      opacity: 1,
      durationS: duration * 1.1,
      reverse: true,
    },
    {
      path: wavePath(amplitude, 96, 4.1),
      fill: "#32a4ff", // ocean-500 — front, brightest
      opacity: 0.95,
      durationS: duration,
    },
  ];

  return (
    <div className="relative overflow-hidden rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>〰️</span>
        <span>Waves</span>
      </div>

      <div className="relative mt-2 h-24 w-full overflow-hidden rounded-xl bg-sky-50 dark:bg-slate-950/40 sm:h-28">
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden
        >
          {layers.map((layer, i) => (
            <path
              key={i}
              d={layer.path}
              fill={layer.fill}
              opacity={layer.opacity}
              style={{
                animation: `${layer.reverse ? "wavescroll-rev" : "wavescroll"} ${layer.durationS.toFixed(2)}s linear infinite`,
              }}
            />
          ))}
        </svg>

        <div className="relative flex h-full flex-col items-start justify-end p-3">
          <div className="text-2xl font-bold text-white drop-shadow-sm sm:text-3xl">
            {waveHeightFt.toFixed(1).replace(/\.0$/, "")} ft
          </div>
          <div className="text-xs font-medium text-white/90 drop-shadow-sm">
            {state.label}
            {swellPeriodS != null ? ` · ${Math.round(swellPeriodS)}s period` : ""}
          </div>
        </div>
      </div>

      <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">{state.note}</div>
    </div>
  );
}
