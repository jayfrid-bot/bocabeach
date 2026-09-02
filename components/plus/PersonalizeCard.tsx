"use client";

import { profileLabel } from "@/lib/profile/resolve";
import type { ScoreProfile } from "@/lib/profile/types";
import { previewReminder } from "@/lib/plus/preview";
import type { PreviewRecord } from "@/lib/plus/types";

/**
 * The door to Plus that lives under the score.
 *
 * Two states, and only two. Someone who has never answered the questions is
 * offered them. Someone who answered and did not subscribe sees a locked pill
 * with no number in it — we promised one reveal and this is us keeping to it —
 * plus a reminder of what their number did that day. Subscribers never see this
 * card at all: their number IS the headline.
 */
export function PersonalizeCard({
  profile,
  preview,
  onPersonalize,
  onUpgrade,
}: {
  profile: ScoreProfile | null;
  preview: PreviewRecord | null;
  /** No profile yet — open the questions. */
  onPersonalize: () => void;
  /** Profile already answered — go straight to the paywall. */
  onUpgrade: () => void;
}) {
  if (!profile) {
    return (
      <button
        type="button"
        onClick={onPersonalize}
        className="mx-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-white/80 px-4 py-3 text-left ring-1 ring-slate-900/10 transition hover:ring-ocean-500/40 dark:bg-slate-900/70 dark:ring-white/10"
      >
        <span aria-hidden className="shrink-0 text-xl leading-none">
          🎯
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900 dark:text-white">
            Personalize my score
          </span>
          <span className="block text-xs leading-snug text-slate-600 dark:text-slate-400">
            Three questions and today gets scored for what you actually come here to do.
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">
          ›
        </span>
      </button>
    );
  }

  const reminder = previewReminder(preview);
  return (
    <button
      type="button"
      onClick={onUpgrade}
      className="mx-auto flex w-full max-w-md items-center gap-3 rounded-2xl bg-white/80 px-4 py-3 text-left ring-1 ring-slate-900/10 transition hover:ring-ocean-500/40 dark:bg-slate-900/70 dark:ring-white/10"
    >
      <span aria-hidden className="shrink-0 text-xl leading-none">
        🔒
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-slate-900 dark:text-white">
          Your score
        </span>
        <span className="block text-xs leading-snug text-slate-600 dark:text-slate-400">
          {reminder ?? `Saved and tuned for ${profileLabel(profile)}.`} Unlock it with Beach Day Plus.
        </span>
      </span>
      <span aria-hidden className="shrink-0 text-slate-400">
        ›
      </span>
    </button>
  );
}
