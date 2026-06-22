import type { ScoreResult } from "@/lib/types";
import { scoreColor } from "@/lib/format";

export function ScoreBreakdown({ result }: { result: ScoreResult }) {
  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-5 ring-1 ring-slate-900/10 dark:ring-white/10">
      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">Score breakdown</h3>

      {result.caps.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {result.caps.map((c, i) => (
            <li
              key={i}
              className="rounded-lg bg-rose-500/10 px-3 py-1.5 text-xs text-rose-700 dark:text-rose-300 ring-1 ring-rose-500/30"
            >
              ⚠ {c} (score capped)
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-3 space-y-2.5">
        {/* Only show factors that actually scored for THIS beach. A component
            with no data source here (cam-derived seaweed/crowd on a cam-less
            beach, traffic without a key, etc.) is omitted rather than listed as
            "n/a", so the breakdown reflects only what shaped the score. */}
        {result.subScores
          .filter((s) => s.score != null)
          .map((s) => (
            <li key={s.key}>
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-slate-700 dark:text-slate-300">
                  {s.label}
                </span>
                <span className="shrink-0 whitespace-nowrap text-slate-600 dark:text-slate-400">
                  {s.display ? `${s.display} · ` : ""}
                  {s.score}/100
                  <span className="ml-1 text-slate-500">
                    (weight {Math.round(s.weight * 100)}%)
                  </span>
                </span>
              </div>
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${s.score}%`,
                    background: scoreColor(s.score as number),
                  }}
                />
              </div>
            </li>
          ))}
      </ul>
    </div>
  );
}
