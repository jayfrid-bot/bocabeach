import type { Wrapped, SunData } from "@/lib/types";

const SYNODIC_DAYS = 29.5;

// The eight phases in cycle order; index i is centered at fraction i/8.
const PHASES = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
const PHASE_NAMES = [
  "New moon",
  "Waxing crescent",
  "First quarter",
  "Waxing gibbous",
  "Full moon",
  "Waning gibbous",
  "Last quarter",
  "Waning crescent",
];

/**
 * The full lunar cycle as its own card: all eight phases in order with
 * tonight's highlighted, and a progress track showing exactly where tonight
 * falls between new moon (0) and the next new moon.
 */
export function MoonPanel({ sun }: { sun: Wrapped<SunData> }) {
  const moon = sun.data?.moonPhase;

  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>{moon?.emoji ?? "🌙"}</span>
          <span>Moon</span>
        </div>
        {moon ? (
          <span className="text-sm text-slate-900 dark:text-white">
            {moon.phase}{" "}
            <span className="text-xs text-slate-500">({moon.illumination}% lit)</span>
          </span>
        ) : null}
      </div>

      {!moon ? (
        <div className="mt-2 text-sm text-slate-500">Unavailable</div>
      ) : (
        <MoonCycleBody moon={moon} />
      )}
    </div>
  );
}

function MoonCycleBody({ moon }: { moon: NonNullable<SunData["moonPhase"]> }) {
  const frac = Math.min(0.999, Math.max(0, moon.fraction));
  const activeIdx = Math.round(frac * 8) % 8;
  const day = Math.floor(frac * SYNODIC_DAYS) + 1;

  return (
    <>
      {/* the eight phases in cycle order, tonight's highlighted */}
      <div className="mt-3 flex justify-between" aria-hidden>
        {PHASES.map((p, i) => (
          <span
            key={i}
            title={PHASE_NAMES[i]}
            className={
              i === activeIdx
                ? "scale-125 rounded-full bg-slate-300/60 dark:bg-slate-700/60 px-1 text-lg ring-1 ring-amber-400/60"
                : "px-1 text-lg opacity-40"
            }
          >
            {p}
          </span>
        ))}
      </div>

      {/* progress through the ~29.5-day cycle */}
      <div className="relative mt-3 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className="h-1.5 rounded-full bg-gradient-to-r from-slate-600 to-amber-400/80"
          style={{ width: `${frac * 100}%` }}
        />
        <span
          className="absolute -top-[3px] h-3 w-3 -translate-x-1/2 rounded-full bg-amber-400 ring-2 ring-slate-950"
          style={{ left: `${frac * 100}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-slate-500">
        <span>new</span>
        <span>full</span>
        <span>
          day {day} of {SYNODIC_DAYS}
        </span>
      </div>
    </>
  );
}
