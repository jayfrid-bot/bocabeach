"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * A quiet, full-width advisory ROW — the shape the exception-only advisories
 * (marine stingers, shark seasonal context) use instead of a card.
 *
 * Rationale: these advisories are the rarest things on the page and speak one at
 * a time far more often than in pairs, so a 2-up card grid left a visible hole
 * whenever only one of them had something to say. A slim strip stacks cleanly at
 * any count of one, and reads like TidePanel's aberration badges — the app's
 * existing "here's an exception worth knowing" language — rather than competing
 * with the instrument cards above it.
 *
 * A slim row can't host a card flip (the nerd back is many times its height), so
 * the science note is reached through an inline ⓘ toggle that expands it
 * directly below the strip, keeping the same content one tap away.
 */
export function AdvisoryStrip({
  icon,
  /** Short headline — the tone-colored lead, e.g. "Elevated man-o'-war advisory". */
  headline,
  /** Tailwind text-color classes (light + dark) for the headline. */
  headlineClass,
  /** The one-line detail that follows the headline. Clamped to a single line;
   *  the full text is always present in the expandable note. */
  detail,
  /** Optional small confidence/qualifier pill at the end of the row. */
  pill,
  /** Expanded science note — the same NerdBack the card version used. */
  note,
  /** Accessible name for the toggle, e.g. "man-o'-war advisory". */
  label,
}: {
  icon: string;
  headline: string;
  headlineClass?: string;
  detail?: string;
  pill?: { label: string; tone: string } | null;
  note: ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <div>
      <div className="flex items-center gap-2 rounded-xl bg-white/80 px-3 py-2 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
        <span aria-hidden className="text-sm leading-none">
          {icon}
        </span>
        <div className="min-w-0 flex-1 truncate text-xs" title={detail ? `${headline} — ${detail}` : headline}>
          <span className={`font-semibold ${headlineClass ?? "text-slate-700 dark:text-slate-200"}`}>
            {headline}
          </span>
          {detail ? (
            <span className="text-slate-600 dark:text-slate-400">{` — ${detail}`}</span>
          ) : null}
        </div>
        {pill ? (
          <span
            className={`hidden shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 sm:inline-flex ${pill.tone}`}
          >
            {pill.label}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={
            open ? `Hide the science behind the ${label}` : `Show the science behind the ${label}`
          }
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs text-slate-400 ring-1 ring-slate-900/10 transition hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500/70 dark:text-slate-500 dark:ring-white/10 dark:hover:text-slate-300"
        >
          <span aria-hidden>ⓘ</span>
        </button>
      </div>
      {open ? (
        <div id={panelId} className="mt-2">
          {note}
        </div>
      ) : null}
    </div>
  );
}
