import type { ScoreResult } from "@/lib/types";

// Cap reasons that mean "don't get in the water" (a safety override), vs the
// quieter quality caps (rain/wind/seaweed) that just hold the number down. The
// strings come from applyBeachCaps in lib/score.ts — matched on stable keywords
// so a reworded cap still classifies correctly.
const SAFETY = /flag|advisory|lightning|thunder|rip current|severe|surf|coastal[- ]flood|closed|no-swim/i;

function isSafety(caps: readonly string[]): boolean {
  return caps.some((c) => SAFETY.test(c));
}

export interface CapState {
  show: boolean;
  safety: boolean;
}

/** Pure show/tone decision for the cap banner — a cap only "shows" when it is
 *  actually holding the score below the raw weighted value. Tested. */
export function capState(result: ScoreResult): CapState {
  const show =
    result.dataAvailable !== false &&
    result.caps.length > 0 &&
    result.score < result.rawScore;
  return { show, safety: show && isSafety(result.caps) };
}

/**
 * When a safety/quality cap is holding the Beach Day score below what the
 * weighted conditions would otherwise give, say so — it explains an
 * otherwise-confusing low score. Renders nothing when no cap is actually
 * lowering the score.
 *
 * Deliberately a compact one/two-line note, not a big block: it sits right
 * under the score wheel now (the wheel itself is already the loud signal),
 * so this only needs to add the "why", not repeat the alarm.
 */
export function ScoreCapBanner({ result }: { result: ScoreResult }) {
  const { show, safety } = capState(result);
  if (!show) return null;
  const tone = safety
    ? "bg-rose-500/10 text-rose-800 ring-rose-500/30 dark:text-rose-200"
    : "bg-amber-500/10 text-amber-800 ring-amber-500/30 dark:text-amber-200";

  return (
    <div
      role="status"
      className={`mx-auto mb-2 flex w-full max-w-md items-start gap-2 rounded-xl px-3 py-2 text-xs leading-snug ring-1 sm:text-sm ${tone}`}
    >
      <span aria-hidden className="mt-0.5 shrink-0 text-sm leading-none">
        ⚠️
      </span>
      <span className="min-w-0">
        <span className="font-semibold tabular-nums">
          {safety ? "Safety cap — " : "Capped — "}
          {result.score}:{" "}
        </span>
        {result.caps.join(" · ")}
        {safety ? " — heed lifeguards and posted flags." : "."}
      </span>
    </div>
  );
}
