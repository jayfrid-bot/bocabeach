import type { ScoreResult } from "@/lib/types";
import { FACTOR_WORDS } from "@/lib/score";

/**
 * Quiet, honest disclosure for a score built on thin data — most beaches have
 * no cams, so seaweed/crowds/(clarity for some profiles) routinely read
 * "unknown" rather than a real value. Shown under the score/verdict for both
 * `partial` and `limited` coverage; renders nothing for `full` (the common
 * case: 3 of 39 beaches have cams today, but their missing weight stays under
 * the 15% partial threshold for the free/Everyone score).
 *
 * `limited` also carries a numeric cap (LIMITED_DATA_CAP in lib/score.ts,
 * surfaced via ScoreCapBanner) — this note explains WHY, in plain words.
 */
export function DataCoverageNote({ result }: { result: ScoreResult }) {
  const tier = result.dataCoverage;
  if (tier == null || tier === "full") return null;
  const missing = result.missingFactors ?? [];
  const estimated = result.estimatedFactors ?? [];
  if (!missing.length && !estimated.length) return null;

  const lead = tier === "limited" ? "Limited data" : "Partial data";

  return (
    <p
      role="note"
      className="mx-auto mb-3 max-w-md text-center text-xs leading-snug text-slate-500 dark:text-slate-400"
    >
      <span className="font-medium text-slate-600 dark:text-slate-300">{lead}:</span>{" "}
      {missing.length > 0 && <>no {formatWordList(missing.map((k) => FACTOR_WORDS[k] ?? k))} for this beach.</>}
      {missing.length > 0 && estimated.length > 0 && " "}
      {estimated.length > 0 && (
        <>estimated: {formatWordList(estimated.map((k) => FACTOR_WORDS[k] ?? k))}.</>
      )}
    </p>
  );
}

/** "a, b, and c" — the plain-English join used above. */
function formatWordList(words: string[]): string {
  if (words.length === 1) return words[0];
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}
