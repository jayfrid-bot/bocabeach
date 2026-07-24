import type { SharkContext, SharkFactor, SharkSeason } from "@/lib/sharkContext";
import type { NerdInfo } from "@/lib/nerdInfo";
import { NerdBack } from "@/components/FlipCard";
import { AdvisoryStrip } from "@/components/AdvisoryStrip";

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
    // The strip clamps the note to one line and has no room for the rarity
    // note, so both live here in full — nothing the card used to show is lost.
    context.note,
    context.rarityNote,
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
      "shoulder from late August into November. Most winters, blacktip sharks aggregate near shore — sometimes " +
      "in large numbers, within tens of metres — specifically along the Palm Beach/Boca Raton coast, part of a " +
      "migration FAU's Shark Lab has documented for years — the window running roughly December-March, peaking " +
      "late February-March, then moving on as the water warms (the scale varies year to year).",
    computation,
    sources: [
      "Florida Museum of Natural History — shark research & Florida bite statistics",
      "FAU Shark Lab — SE-Florida winter blacktip aggregation research",
      "Seasonal climatology — SE-US Atlantic mullet run (Aug-Nov) and SE-Florida blacktip aggregation (Dec-Mar)",
    ],
    notes:
      "This is CONTEXT, not a forecast and not a live map — nothing here claims to know where any shark is " +
      "right now, or what the odds are today. It only ever surfaces during a documented seasonal window, or " +
      "when murky water and low-light hours coincide. Always defer to the lifeguard's posted flags (a purple " +
      "flag means dangerous marine life has actually been seen) over any seasonal note here.",
    formula:
      "season = 'mullet-run' if month is Sep/Oct (peak), or Aug/Nov with water temp cooling to ≤81°F " +
      "(shoulder); 'blacktip-aggregation' if month is Dec-Mar AND latitude is ~25.5-27.5°N (SE Florida only). " +
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
  // Quiet, exception-only advisory: nothing seasonal or notable today -> render nothing.
  if (!context) return null;

  // One slim strip (see components/AdvisoryStrip.tsx), matching the marine-
  // stinger advisories it sits beside. Still the least alarming thing on the
  // page: slate tone throughout, no escalation color, no number.
  return (
    <AdvisoryStrip
      icon="🦈"
      label="shark seasonal note"
      headline={context.season ? SEASON_LABEL[context.season] : "Shark context"}
      detail={context.note}
      pill={{
        label: "Seasonal note",
        tone: "bg-slate-500/10 text-slate-500 ring-slate-500/25 dark:text-slate-400",
      }}
      note={<NerdBack info={buildInfo(context)} />}
    />
  );
}
