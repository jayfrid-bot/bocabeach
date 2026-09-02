"use client";

/**
 * Plus only: swap the headline between the personal score and the one everyone
 * else sees. The personal number leads — that is what was paid for — but the
 * shared number stays one tap away, because "is my score high because of me or
 * because of the day?" is a fair question.
 */
export function ScoreToggle({
  showingEveryone,
  onChange,
  onSettings,
}: {
  showingEveryone: boolean;
  onChange: (showEveryone: boolean) => void;
  /** Opens the Plus settings sheet. */
  onSettings: () => void;
}) {
  const base =
    "inline-flex min-h-[40px] items-center rounded-full px-4 py-1.5 text-sm font-medium transition";
  const on = "bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-white";
  const off = "text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white";

  return (
    <div className="mb-3 flex items-center justify-center gap-2">
      <div
        role="group"
        aria-label="Which score to show"
        className="inline-flex rounded-full bg-slate-900/5 p-1 dark:bg-white/5"
      >
        <button
          type="button"
          onClick={() => onChange(false)}
          aria-pressed={!showingEveryone}
          className={`${base} ${showingEveryone ? off : on}`}
        >
          Your score
        </button>
        <button
          type="button"
          onClick={() => onChange(true)}
          aria-pressed={showingEveryone}
          className={`${base} ${showingEveryone ? on : off}`}
        >
          Everyone&apos;s
        </button>
      </div>
      <button
        type="button"
        onClick={onSettings}
        aria-label="Beach Day Plus settings"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-900/5 text-slate-600 transition hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-300 dark:hover:bg-white/10"
      >
        <span aria-hidden className="text-base leading-none">
          ⚙️
        </span>
      </button>
    </div>
  );
}
