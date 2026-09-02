"use client";

import type { Derived } from "@/lib/score";
import { surfConditions, swimSafety } from "@/lib/safetyLine";
import type { ScoreProfile } from "@/lib/profile/types";
import type { ConditionsSnapshot } from "@/lib/types";

/**
 * The safety line under the score. The SCORE is personal — a red flag does not
 * spoil a sunbather's day — so this line carries the hazards the score no longer
 * caps for. It is shown to everybody, free or paid: safety information is never
 * a paid feature. Surfers are the one profile that gets a different QUESTION
 * ("should I paddle out"), not a softer answer.
 */
const SWIM_WORDS = { safe: "Safe", caution: "Use caution", "stay-out": "Stay out" } as const;
const SURF_WORDS = { go: "Go", experienced: "Experienced only", closed: "Closed" } as const;

const TONE = {
  good: "bg-emerald-500/10 text-emerald-800 ring-emerald-500/25 dark:text-emerald-300",
  warn: "bg-amber-500/10 text-amber-900 ring-amber-500/30 dark:text-amber-200",
  stop: "bg-rose-500/10 text-rose-800 ring-rose-500/30 dark:text-rose-200",
} as const;

export function SafetyLine({
  derived,
  snapshot,
  profile,
}: {
  derived: Derived;
  snapshot: ConditionsSnapshot;
  /** The active profile, when there is one. Only "surf" changes the question. */
  profile: ScoreProfile | null;
}) {
  const surfing = !!profile?.profiles?.includes("surf");

  let heading: string;
  let word: string;
  let tone: keyof typeof TONE;
  let reasons: string[];

  if (surfing) {
    const line = surfConditions(derived, snapshot);
    heading = "Surf conditions";
    word = SURF_WORDS[line.level];
    tone = line.level === "go" ? "good" : line.level === "experienced" ? "warn" : "stop";
    reasons = line.reasons;
  } else {
    const line = swimSafety(derived, snapshot);
    heading = "Swim safety";
    word = SWIM_WORDS[line.level];
    tone = line.level === "safe" ? "good" : line.level === "caution" ? "warn" : "stop";
    reasons = line.reasons;
  }

  const icon = tone === "good" ? "🟢" : tone === "warn" ? "🟡" : "🔴";

  return (
    <div
      role="status"
      className={`mx-auto mt-3 flex w-full max-w-md items-start gap-2.5 rounded-2xl px-4 py-3 text-sm ring-1 ${TONE[tone]}`}
    >
      <span aria-hidden className="mt-0.5 shrink-0 text-base leading-none">
        {icon}
      </span>
      <div className="min-w-0">
        <span className="font-semibold">
          {heading}: {word}
        </span>
        {reasons.length ? (
          <span className="ml-1.5 leading-snug">{reasons[0]}</span>
        ) : null}
      </div>
    </div>
  );
}
