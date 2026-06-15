import { degToCardinal } from "@/lib/util";
import { WindSpinner } from "@/components/WindSpinner";

/**
 * Wind compass. `fromDeg` is the direction the wind blows FROM; the needle
 * points the way the wind travels (fromDeg + 180). The needle eases to new
 * readings (CSS transition) and carries a gust wobble whose swing and tempo
 * scale with wind speed, so the dial reads "alive" in a stiff breeze and
 * settles in calm air.
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
  const mph = Math.max(0, speedMph ?? 0);
  // Wobble: none when calm, up to ±7° in a blow; gusts feel quicker too.
  const wobbleDeg = mph < 2 ? 0 : Math.min(7, 1.5 + mph * 0.28);
  const wobbleSecs = Math.max(0.7, 2.4 - mph * 0.06);

  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 80 80" className="h-16 w-16">
        {/* dial */}
        <circle
          cx="40"
          cy="40"
          r="37"
          strokeWidth="2"
          className="fill-slate-100 stroke-slate-300 dark:fill-slate-900 dark:stroke-slate-700"
        />
        <circle
          cx="40"
          cy="40"
          r="30"
          fill="none"
          strokeWidth="1"
          className="stroke-slate-300 dark:stroke-slate-700"
        />

        {/* degree ticks: bold at cardinals, light at intercardinals */}
        {Array.from({ length: 8 }, (_, i) => {
          const cardinal = i % 2 === 0;
          return (
            <line
              key={i}
              x1="40"
              y1={cardinal ? 4.5 : 6}
              x2="40"
              y2={cardinal ? 10.5 : 9.5}
              strokeWidth={cardinal ? 2 : 1}
              transform={`rotate(${i * 45} 40 40)`}
              className="stroke-slate-300 dark:stroke-slate-700"
            />
          );
        })}

        {/* cardinal letters */}
        <text x="40" y="19" textAnchor="middle" fontSize="9" fontWeight="700" className="fill-slate-600 dark:fill-slate-400">N</text>
        <text x="63.5" y="43" textAnchor="middle" fontSize="8" className="fill-slate-600 dark:fill-slate-400">E</text>
        <text x="40" y="66.5" textAnchor="middle" fontSize="8" className="fill-slate-600 dark:fill-slate-400">S</text>
        <text x="16.5" y="43" textAnchor="middle" fontSize="8" className="fill-slate-600 dark:fill-slate-400">W</text>

        {known ? (
          <g
            style={{
              transform: `rotate(${travelDeg}deg)`,
              transformOrigin: "40px 40px",
              transition: "transform 800ms ease-in-out",
            }}
          >
            <g
              style={
                wobbleDeg
                  ? ({
                      "--wobble": `${wobbleDeg.toFixed(1)}deg`,
                      transformOrigin: "40px 40px",
                      animation: `windwobble ${wobbleSecs.toFixed(2)}s ease-in-out infinite alternate`,
                    } as React.CSSProperties)
                  : { transformOrigin: "40px 40px" }
              }
            >
              {/* needle: bright head (where the wind goes), dim tail */}
              <path d="M40 13 L46 42 L40 37 L34 42 Z" fill="#38bdf8" />
              <path d="M40 60 L43.5 44 L40 47 L36.5 44 Z" fill="#475569" />
              <circle cx="40" cy="40" r="3.4" fill="#94a3b8" stroke="#0f172a" strokeWidth="1.5" />
            </g>
          </g>
        ) : (
          <text x="40" y="45" textAnchor="middle" fontSize="12" className="fill-slate-600 dark:fill-slate-400">?</text>
        )}
      </svg>
      <WindSpinner speedMph={speedMph} />
      <div>
        <div className="text-2xl font-semibold text-slate-900 dark:text-white">
          {typeof speedMph === "number" ? `${speedMph} mph` : "—"}
        </div>
        <div className="text-xs text-slate-600 dark:text-slate-400">
          {known
            ? `from ${degToCardinal(fromDeg as number)} · blowing ${degToCardinal(travelDeg % 360)}`
            : "direction n/a"}
        </div>
      </div>
    </div>
  );
}
