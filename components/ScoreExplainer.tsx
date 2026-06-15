import type { Derived } from "@/lib/score";
import type { ScoreResult } from "@/lib/types";
import { explainScore } from "@/lib/explain";

/**
 * Plain-English explanation of the Beach Day score: what's lifting it up
 * today, what's holding it back. Replaces the technical sub-score bars with
 * sentences a beachgoer can scan in two seconds. Caps (flags, storms,
 * advisories) appear at the top of the "holding it back" column since
 * they're the single biggest reason the score is what it is.
 */
export function ScoreExplainer({
  derived,
  result,
}: {
  derived: Derived;
  result: ScoreResult;
}) {
  const { summary, helping, hurting } = explainScore(derived, result);

  return (
    <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-5 ring-1 ring-slate-900/10 dark:ring-white/10">
      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">
        Why this score
      </h3>
      <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
        {summary}
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
            <span aria-hidden>✅</span> Helping today
          </h4>
          {helping.length ? (
            <ul className="mt-2 space-y-2">
              {helping.map((r, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-lg bg-emerald-500/5 px-3 py-2 text-sm text-slate-700 ring-1 ring-emerald-500/15 dark:bg-emerald-500/10 dark:text-slate-200 dark:ring-emerald-500/20"
                >
                  <span aria-hidden className="shrink-0 text-base leading-none">
                    {r.emoji}
                  </span>
                  <span className="min-w-0">{r.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs italic text-slate-500">
              Nothing especially in your favor right now.
            </p>
          )}
        </section>

        <section>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
            <span aria-hidden>⚠️</span> Holding it back
          </h4>
          {hurting.length ? (
            <ul className="mt-2 space-y-2">
              {hurting.map((r, i) => (
                <li
                  key={i}
                  className="flex items-start gap-2 rounded-lg bg-rose-500/5 px-3 py-2 text-sm text-slate-700 ring-1 ring-rose-500/15 dark:bg-rose-500/10 dark:text-slate-200 dark:ring-rose-500/20"
                >
                  <span aria-hidden className="shrink-0 text-base leading-none">
                    {r.emoji}
                  </span>
                  <span className="min-w-0">{r.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs italic text-slate-500">
              Nothing dragging it down — enjoy!
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
