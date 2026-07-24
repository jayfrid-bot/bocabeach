"use client";

import { useState } from "react";
import { CHANGELOG, type ChangelogTag } from "@/lib/changelog";

const TAG_LABEL: Record<ChangelogTag, string> = {
  new: "New",
  improved: "Improved",
  fixed: "Fixed",
};

const TAG_CLASS: Record<ChangelogTag, string> = {
  new: "bg-ocean-500/10 text-ocean-700 ring-ocean-500/20 dark:bg-ocean-400/10 dark:text-ocean-300 dark:ring-ocean-400/20",
  improved:
    "bg-amber-500/10 text-amber-700 ring-amber-500/20 dark:bg-amber-400/10 dark:text-amber-300 dark:ring-amber-400/20",
  fixed:
    "bg-slate-500/10 text-slate-600 ring-slate-500/20 dark:bg-slate-400/10 dark:text-slate-300 dark:ring-slate-400/20",
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** Formats a plain "YYYY-MM-DD" string without going through a Date/timezone. */
function fmtChangelogDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const month = MONTHS[(m ?? 1) - 1] ?? "";
  return `${month} ${d}, ${y}`;
}

const PREVIEW_COUNT = 3;

/**
 * Quiet "What's new" section for the very bottom of the page, next to the
 * footer's build-identity line. Collapsed by default: shows the 3 most
 * recent changelog entries, with a "Show all" expander for the rest.
 */
export function ChangelogSection() {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? CHANGELOG : CHANGELOG.slice(0, PREVIEW_COUNT);
  const hiddenCount = CHANGELOG.length - PREVIEW_COUNT;

  return (
    <section className="mx-auto mt-2 max-w-md text-left">
      <h2 className="text-center text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        What&rsquo;s new
      </h2>
      <ul className="mt-2 space-y-2.5">
        {visible.map((entry, i) => (
          <li key={`${entry.date}-${i}`} className="text-xs">
            <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
              <span className="text-slate-400 dark:text-slate-500">
                {fmtChangelogDate(entry.date)}
              </span>
              <span className="text-slate-300 dark:text-slate-600" aria-hidden>
                ·
              </span>
              {entry.tag ? (
                <span
                  className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ${TAG_CLASS[entry.tag]}`}
                >
                  {TAG_LABEL[entry.tag]}
                </span>
              ) : null}
              <span className="text-slate-600 dark:text-slate-300">{entry.title}</span>
            </div>
            {entry.details ? (
              <p className="mt-0.5 text-slate-400 dark:text-slate-500">{entry.details}</p>
            ) : null}
          </li>
        ))}
      </ul>
      {hiddenCount > 0 ? (
        <div className="mt-2.5 flex justify-center">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-ocean-700 hover:underline dark:text-ocean-300"
            aria-expanded={expanded}
          >
            {expanded ? "Show less" : `Show all (${CHANGELOG.length})`}
          </button>
        </div>
      ) : null}
    </section>
  );
}
