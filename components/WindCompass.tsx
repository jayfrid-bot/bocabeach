import { degToCardinal } from "@/lib/util";

/**
 * Small compass. `fromDeg` is the direction the wind is blowing FROM;
 * the arrow points the way the wind is travelling (i.e. fromDeg + 180).
 */
export function WindCompass({
  fromDeg,
  speedMph,
}: {
  fromDeg?: number;
  speedMph?: number;
}) {
  const known = typeof fromDeg === "number";
  const travelDeg = known ? (fromDeg as number) + 180 : 0;
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 60 60" className="h-12 w-12">
        <circle
          cx="30"
          cy="30"
          r="27"
          fill="color-mix(in srgb, var(--ink) 5%, transparent)"
          stroke="var(--sand-line)"
          strokeWidth="2"
        />
        <text x="30" y="13" textAnchor="middle" fill="var(--ink-faint)" fontSize="8">
          N
        </text>
        {known ? (
          <g transform={`rotate(${travelDeg} 30 30)`}>
            <path d="M30 12 L36 40 L30 34 L24 40 Z" fill="var(--sea)" />
          </g>
        ) : (
          <text x="30" y="34" textAnchor="middle" fill="var(--ink-faint)" fontSize="10">
            ?
          </text>
        )}
      </svg>
      <div>
        <div className="font-head text-2xl font-bold text-ink">
          {typeof speedMph === "number" ? `${speedMph}` : "—"}
          {typeof speedMph === "number" ? (
            <span className="ml-1 text-sm font-normal text-ink-faint">mph</span>
          ) : null}
        </div>
        <div className="text-xs text-ink-faint">
          {known ? `from ${degToCardinal(fromDeg as number)}` : "direction n/a"}
        </div>
      </div>
    </div>
  );
}
