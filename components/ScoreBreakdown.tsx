import type { ScoreResult } from "@/lib/types";
import { scoreColor } from "@/lib/format";

export function ScoreBreakdown({ result }: { result: ScoreResult }) {
  return (
    <div className="rounded-2xl bg-slate-900/70 p-5 ring-1 ring-white/10">
      <h3 className="text-sm font-medium text-slate-300">Why this score</h3>

      {result.caps.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {result.caps.map((c, i) => (
            <li
              key={i}
              className="rounded-lg bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 ring-1 ring-rose-500/30"
            >
              ⚠ {c} (score capped)
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-3 space-y-2.5">
        {result.subScores.map((s) => (
          <li key={s.key}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300">{s.label}</span>
              <span className="text-slate-400">
                {s.display ? `${s.display} · ` : ""}
                {s.score == null ? "n/a" : `${s.score}`}
                <span className="ml-1 text-slate-500">
                  ({Math.round(s.weight * 100)}%)
                </span>
              </span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${s.score ?? 0}%`,
                  background: s.score == null ? "#475569" : scoreColor(s.score),
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
