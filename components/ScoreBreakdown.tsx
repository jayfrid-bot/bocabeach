import type { ScoreResult } from "@/lib/types";
import { scoreColor } from "@/lib/format";

/** "What's driving this" — the weighted sub-scores + any safety caps. */
export function ScoreBreakdown({ result }: { result: ScoreResult }) {
  return (
    <div>
      <h3 className="font-head text-sm font-semibold uppercase tracking-[0.04em] text-ink-soft">
        What&apos;s driving this
      </h3>

      {result.caps.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {result.caps.map((c, i) => (
            <li
              key={i}
              className="rounded-sm px-3 py-1.5 text-xs font-medium"
              style={{
                color: "var(--coral)",
                background: "color-mix(in srgb, var(--coral) 12%, transparent)",
                border: "1px solid color-mix(in srgb, var(--coral) 30%, transparent)",
              }}
            >
              ⚠ {c} (score capped)
            </li>
          ))}
        </ul>
      ) : null}

      <ul className="mt-3 space-y-2.5">
        {result.subScores.map((s) => (
          <li key={s.key}>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate text-ink-soft">{s.label}</span>
              <span className="shrink-0 whitespace-nowrap text-ink-faint">
                {s.display ? `${s.display} · ` : ""}
                {s.score == null ? "n/a" : `${s.score}`}
                <span className="ml-1 text-ink-faint">({Math.round(s.weight * 100)}%)</span>
              </span>
            </div>
            <div
              className="mt-1 h-1.5 w-full overflow-hidden rounded-full"
              style={{ background: "color-mix(in srgb, var(--ink) 8%, transparent)" }}
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${s.score ?? 0}%`,
                  background: s.score == null ? "var(--ink-faint)" : scoreColor(s.score),
                }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
