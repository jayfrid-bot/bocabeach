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
 * weighted conditions would otherwise give, say so RIGHT AT THE TOP — the cap
 * is the single most important thing on the page when it's active (it's usually
 * a "get out of the water" reason), and it explains an otherwise-confusing low
 * score. Renders nothing when no cap is actually lowering the score.
 */
export function ScoreCapBanner({ result }: { result: ScoreResult }) {
  const { show, safety } = capState(result);
  if (!show) return null;
  const tone = safety
    ? "bg-rose-500/10 text-rose-800 ring-rose-500/30 dark:text-rose-200"
    : "bg-amber-500/10 text-amber-800 ring-amber-500/30 dark:text-amber-200";
  const icon = safety ? "⚠️" : "⚠️";

  return (
    <div
      role="status"
      className={`mx-auto mb-3 flex w-full max-w-md items-start gap-2.5 rounded-2xl px-4 py-3 text-sm ring-1 ${tone}`}
    >
      <span aria-hidden className="mt-0.5 shrink-0 text-base leading-none">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="font-semibold tabular-nums">
          {safety ? "Safety cap — score held at " : "Score held at "}
          {result.score}
        </div>
        <div className="mt-0.5 leading-snug">
          {result.caps.join(" · ")}
          {safety ? " — heed lifeguards and posted flags." : "."}
        </div>
      </div>
    </div>
  );
}
