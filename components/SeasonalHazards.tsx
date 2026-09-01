import {
  seasonalHazards,
  type HazardTone,
  type SeasonalHazardsInput,
} from "@/lib/seasonalHazards";

/** Status-pill tone classes, reusing the app's existing pill language:
 *  the slate "wind-only" badge (AdvisoryStrip) for calm, the amber
 *  "improved" chip (ChangelogSection) for in-season / peak / watch. */
const PILL_TONE: Record<HazardTone, string> = {
  calm: "bg-slate-500/10 text-slate-600 ring-slate-500/25 dark:text-slate-300",
  amber: "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
};

/**
 * Always-on "What's in the water" panel — a calm, glanceable seasonal reference
 * for the three SE-Florida ocean hazards (man-o'-war, sea lice, sharks). Unlike
 * the exception-only advisories it replaces, this stays visible every day for
 * beaches where the science applies, so a beachgoer always sees whether it's the
 * season for each. Purely informational; never a risk score (see
 * lib/seasonalHazards.ts).
 *
 * Rendered only for SE-US-Atlantic-oriented beaches — the CALLER gates that
 * (see ConditionsDashboard); this component assumes the beach qualifies.
 */
export function SeasonalHazards(props: SeasonalHazardsInput) {
  const rows = seasonalHazards(props);
  if (rows.length === 0) return null;

  return (
    <div className="rounded-2xl bg-white/80 px-4 py-3 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <h2 className="text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        What&rsquo;s in the water
      </h2>
      <ul className="mt-2.5 space-y-2.5">
        {rows.map((row) => (
          <li
            key={row.key}
            className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2"
          >
            <div className="flex shrink-0 items-center gap-1.5">
              <span aria-hidden className="text-sm leading-none">
                {row.icon}
              </span>
              <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">
                {row.name}
              </span>
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ${PILL_TONE[row.tone]}`}
              >
                {row.statusLabel}
              </span>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 sm:flex-1">{row.line}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[10px] text-slate-400 dark:text-slate-500">
        Seasonal guidance for SE-Florida beaches — not a live report.
      </p>
    </div>
  );
}
