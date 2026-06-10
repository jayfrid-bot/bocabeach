/**
 * A tiny anemometer (three-cup wind meter) that spins continuously, one
 * rotation taking less time the harder the wind blows — a live "feel" for the
 * current speed. Pure CSS animation, so it's SSR-safe (no clock reads).
 */
export function WindSpinner({ speedMph }: { speedMph?: number }) {
  const mph = typeof speedMph === "number" && speedMph > 0 ? speedMph : 0;
  // ~30s/turn at 1 mph down to a 0.4s blur in a gale; calm = no spin.
  const secsPerTurn = mph > 0 ? Math.min(30, Math.max(0.4, 30 / mph)) : 0;

  return (
    <svg viewBox="0 0 40 48" className="h-12 w-10" aria-hidden>
      {/* mast */}
      <line x1="20" y1="22" x2="20" y2="44" stroke="#334155" strokeWidth="2.5" strokeLinecap="round" />
      <g
        style={
          secsPerTurn
            ? {
                transformOrigin: "20px 20px",
                animation: `windspin ${secsPerTurn.toFixed(2)}s linear infinite`,
              }
            : undefined
        }
      >
        {/* three cups at 120° apart, each an arm + a little cup circle */}
        {[0, 120, 240].map((deg) => (
          <g key={deg} transform={`rotate(${deg} 20 20)`}>
            <line x1="20" y1="20" x2="20" y2="8" stroke="#64748b" strokeWidth="2" />
            <circle cx="20" cy="6.5" r="4" fill="#38bdf8" opacity="0.9" />
          </g>
        ))}
        <circle cx="20" cy="20" r="2.5" fill="#94a3b8" />
      </g>
    </svg>
  );
}
