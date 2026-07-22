import type { SharkContext, SharkFactor, SharkSeason } from "@/lib/sharkContext";
import type { NerdInfo } from "@/lib/nerdInfo";
import { FlipCard, NerdBack } from "@/components/FlipCard";

const SEASON_LABEL: Record<SharkSeason, string> = {
  "mullet-run": "Mullet-run season",
  "blacktip-aggregation": "Blacktip aggregation season",
};

const FACTOR_LABEL: Record<SharkFactor, string> = {
  "murky water": "Murky water",
  "dawn/dusk": "Dawn/dusk",
  "near inlet": "Near an inlet",
};

/**
 * Build the flip-back "data nerd" explainer from props only — same
 * self-contained pattern MarineStingerCard's `buildInfo` and RipRiskCard's
 * `buildInfo` use, no dependency on lib/nerdInfo.ts's snapshot-driven
 * registry.
 */
function buildInfo(context: SharkContext): NerdInfo {
  const computation: string[] = [
    context.season ? `Season: ${SEASON_LABEL[context.season]}` : "Season: none active right now",
    context.factors.length
      ? `Active factors: ${context.factors.map((f) => FACTOR_LABEL[f]).join(", ")}`
      : "Active factors: none",
  ];

  return {
    title: "Shark seasonal context",
    // Purely informational — never feeds the Beach Day composite score.
    weightPct: null,
    explainer:
      "This is a SEASONAL CONTEXT note, not a live shark tracker. The only free public shark-tracking feed " +
      "(OCEARCH) shows stale last-known positions of the wrong species for this coast — the nearest tagged " +
      "shark's most recent Atlantic ping here dates to 2013 — so a live map would mislead more than it'd help. " +
      "Instead this card draws only on things we already know: the calendar, water temperature, recent weather, " +
      "time of day, and this beach's fixed latitude. Every fall, baitfish migrating south (the \"mullet run\") " +
      "pull blacktip and spinner sharks into the surf zone to feed — primarily September-October, with a " +
      "shoulder from late August into November. Every winter, thousands of blacktip sharks gather within " +
      "roughly 50 m of shore specifically along the Palm Beach/Boca Raton coast, part of a migration FAU's " +
      "Shark Lab has documented for years — peaking late February-March, then moving on as the water warms.",
    computation,
    sources: [
      "Florida Museum of Natural History — shark research & Florida bite statistics",
      "FAU Shark Lab — SE-Florida winter blacktip aggregation research",
      "Seasonal climatology — SE-US Atlantic mullet run (Aug-Nov) and SE-Florida blacktip aggregation (Jan-Mar)",
    ],
    notes:
      "This is CONTEXT, not a forecast and not a live map — nothing here claims to know where any shark is " +
      "right now, or what the odds are today. It only ever surfaces during a documented seasonal window, or " +
      "when murky water and low-light hours coincide. Always defer to the lifeguard's posted flags (a purple " +
      "flag means dangerous marine life has actually been seen) over any seasonal note here.",
    formula:
      "season = 'mullet-run' if month is Sep/Oct (peak), or Aug/Nov with water temp cooling to ≤81°F " +
      "(shoulder); 'blacktip-aggregation' if month is Jan-Mar AND latitude is ~25.5-27.5°N (SE Florida only). " +
      "Micro-factors (murky water, dawn/dusk, near an inlet) are independent and can raise this note's " +
      "awareness even outside a season when murky water and dawn/dusk both apply. No number, score, or shark " +
      "count is ever computed.",
  };
}

export interface SharkContextCardProps {
  context: SharkContext | null;
}

/**
 * Exception-only shark seasonal-context advisory. Mirrors the tide-aberration
 * badges and MarineStingerCard's philosophy: a quiet day (nothing seasonal or
 * notable happening) renders nothing, so this card only ever takes up room
 * when it genuinely has calendar-and-conditions context to add. Deliberately
 * the LEAST alarming card on the page — no red/amber escalation, no numeric
 * risk, no map, styled as a plain informational note. Props-driven and
 * self-contained: pass the output of lib/sharkContext.ts directly.
 *
 * SCOPE: the science this card presents (SE-US Atlantic mullet run, SE-Florida
 * blacktip aggregation) only applies to that coast — lib/sharkContext.ts
 * already gates on latitude and returns `null` elsewhere, but see the
 * integration note in the build report for which beaches should even call it.
 */
export function SharkContextCard({ context }: SharkContextCardProps) {
  // Quiet, exception-only card: nothing seasonal or notable today -> render nothing.
  if (!context) return null;

  const front = (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🦈</span>
        <span>Shark context</span>
        <span className="ml-auto rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-500/20 dark:text-slate-400">
          Seasonal note
        </span>
      </div>

      {context.season ? (
        <div className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          {SEASON_LABEL[context.season]}
        </div>
      ) : null}

      <div className="mt-1 break-words text-xs leading-relaxed text-slate-600 dark:text-slate-400">
        {context.note}
      </div>

      <div className="mt-2 rounded-lg bg-slate-500/5 px-2.5 py-2 text-[11px] leading-relaxed text-slate-500 ring-1 ring-slate-500/10 dark:text-slate-400 dark:ring-white/5">
        {context.rarityNote}
      </div>
    </div>
  );

  return <FlipCard label="Shark context" back={<NerdBack info={buildInfo(context)} />} front={front} />;
}
