import { uvBand, uvBandColor, uvBurnMinutes, uvBurnUrgency } from "@/lib/uv";
import { clamp } from "@/lib/util";

// viewBox geometry for the sun + burn-urgency ring. Coordinates rounded to 2
// decimals so the server-rendered SVG and the client hydration pass agree
// exactly (same convention as ScoreWheel.tsx / WaveHeightCard.tsx).
const SIZE = 112;
const CX = SIZE / 2;
const CY = SIZE / 2;
const RING_R = 48;
const RING_STROKE = 7;
const CIRC = 2 * Math.PI * RING_R;
const RAY_COUNT = 10;

const round2 = (v: number) => Math.round(v * 100) / 100;

function rayLine(angleDeg: number, innerR: number, outerR: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x1: round2(CX + innerR * Math.cos(rad)),
    y1: round2(CY + innerR * Math.sin(rad)),
    x2: round2(CX + outerR * Math.cos(rad)),
    y2: round2(CY + outerR * Math.sin(rad)),
  };
}

/**
 * UV index card: a sun whose rays lengthen/intensify with the UV reading,
 * ringed by a dial that fills up as "minutes to bare-skin burn" shrinks (short
 * burn time = urgent = fuller ring). Renders nothing when there's no UV
 * reading for this beach.
 */
export function UvCard({ uvIndex }: { uvIndex?: number }) {
  if (uvIndex == null) return null;

  // Clamp only the RENDER inputs so a freak reading can't blow the SVG out —
  // the numeric label always shows the true value.
  const uv = clamp(uvIndex, 0, 14);
  const band = uvBand(uvIndex);
  const color = uvBandColor(uvIndex);
  const burn = uvBurnMinutes(uvIndex);
  const urgency = uvBurnUrgency(burn);

  const sunR = 12 + uv * 1.1; // 12 (UV 0) .. ~27.4 (UV 14)
  const rayInner = sunR + 3;
  const rayLen = 5 + uv * 2.2; // rays lengthen with UV
  const rayOuter = rayInner + rayLen;
  const rayOpacity = clamp(0.3 + uv / 14, 0.3, 1); // rays also intensify (more opaque)
  const pulseDuration = clamp(3.2 - uv * 0.14, 1.6, 3.2); // higher UV "breathes" faster

  const dashOffset = round2(CIRC * (1 - urgency));

  return (
    <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🔆</span>
        <span>UV index</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="relative h-14 w-14 shrink-0 sm:h-16 sm:w-16">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-full w-full" aria-hidden>
            <circle
              cx={CX}
              cy={CY}
              r={RING_R}
              fill="none"
              strokeWidth={RING_STROKE}
              className="stroke-slate-200 dark:stroke-slate-800"
            />
            {burn != null ? (
              <circle
                cx={CX}
                cy={CY}
                r={RING_R}
                fill="none"
                strokeWidth={RING_STROKE}
                stroke={color}
                strokeLinecap="round"
                strokeDasharray={`${round2(CIRC)} ${round2(CIRC)}`}
                strokeDashoffset={dashOffset}
                transform={`rotate(-90 ${CX} ${CY})`}
                style={{ transition: "stroke-dashoffset 0.6s ease" }}
              />
            ) : null}
            <g
              style={{
                animation: `sunraypulse ${pulseDuration.toFixed(2)}s ease-in-out infinite`,
                transformOrigin: `${CX}px ${CY}px`,
              }}
            >
              {Array.from({ length: RAY_COUNT }, (_, i) => {
                const angle = (360 / RAY_COUNT) * i;
                const { x1, y1, x2, y2 } = rayLine(angle, rayInner, rayOuter);
                return (
                  <line
                    key={i}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke={color}
                    strokeWidth={2.5}
                    strokeLinecap="round"
                    opacity={rayOpacity}
                  />
                );
              })}
              <circle cx={CX} cy={CY} r={round2(sunR)} fill={color} />
            </g>
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
            {uvIndex}
          </div>
          <div className="text-xs font-medium" style={{ color }}>
            {band}
          </div>
          <div className="break-words text-xs text-slate-600 dark:text-slate-400">
            {burn != null ? `~${burn} min to burn` : "minimal burn risk"}
          </div>
        </div>
      </div>
    </div>
  );
}
