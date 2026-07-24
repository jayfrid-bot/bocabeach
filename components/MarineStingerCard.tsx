import type { ManOWarConfidence, ManOWarLevel, ManOWarRisk, SeaLiceLevel, SeaLiceRisk } from "@/lib/marineStinger";
import type { NerdInfo } from "@/lib/nerdInfo";
import { NerdBack } from "@/components/FlipCard";
import { AdvisoryStrip } from "@/components/AdvisoryStrip";

const MAN_O_WAR_LABEL: Record<ManOWarLevel, string> = {
  low: "Low",
  possible: "Possible",
  elevated: "Elevated",
  high: "High",
};

const SEA_LICE_LABEL: Record<SeaLiceLevel, string> = {
  low: "Low",
  possible: "Possible",
  elevated: "Elevated",
};

/** Tone classes for the man-o'-war headline — escalates amber -> orange ->
 *  rose, matching the amber/orange/rose ramp LightningCard and TidePanel use
 *  elsewhere in the app for "getting more serious". */
const MAN_O_WAR_TONE: Record<ManOWarLevel, string> = {
  low: "text-slate-600 dark:text-slate-400",
  possible: "text-amber-600 dark:text-amber-400",
  elevated: "text-orange-600 dark:text-orange-400",
  high: "text-rose-700 dark:text-rose-400",
};

const SEA_LICE_TONE: Record<SeaLiceLevel, string> = {
  low: "text-slate-600 dark:text-slate-400",
  possible: "text-amber-600 dark:text-amber-400",
  elevated: "text-orange-600 dark:text-orange-400",
};

const CONFIDENCE_BADGE: Record<ManOWarConfidence, { label: string; tone: string }> = {
  observed: {
    label: "Sighted nearby",
    tone: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300",
  },
  "wind-only": {
    label: "Wind-only estimate",
    tone: "bg-slate-500/10 text-slate-600 ring-slate-500/25 dark:text-slate-300",
  },
  low: {
    label: "No recent reports",
    tone: "bg-slate-500/10 text-slate-500 ring-slate-500/25 dark:text-slate-400",
  },
};

function confidenceLabel(c: ManOWarConfidence): string {
  return CONFIDENCE_BADGE[c].label;
}

/**
 * Build the flip-back "data nerd" explainer for whatever combination of
 * man-o'-war / sea-lice readings the card is currently showing. Reuses
 * NerdBack's exact visual chrome (see components/FlipCard.tsx) for a
 * card that feels native to the app, but assembles its own NerdInfo from
 * props only — no dependency on lib/nerdInfo.ts's snapshot-driven builder,
 * keeping this component fully self-contained.
 */
function buildInfo(manOWar: ManOWarRisk | null, seaLice: SeaLiceRisk | null): NerdInfo {
  const computation: string[] = [];
  if (manOWar) {
    computation.push(
      `Man-o'-war: ${MAN_O_WAR_LABEL[manOWar.level]} · score ${manOWar.score}/100 · ${confidenceLabel(manOWar.confidence)}`,
    );
    computation.push(manOWar.note);
  } else {
    computation.push("Man-o'-war: no reading — needs at least ~24h of trailing wind history.");
  }
  if (seaLice) {
    computation.push(`Sea lice: ${SEA_LICE_LABEL[seaLice.level]}`);
    computation.push(seaLice.note);
  } else {
    computation.push("Sea lice: outside the plausible season (SE-FL is roughly March–August).");
  }

  return {
    title: "Marine stinger advisory",
    // Purely informational — never feeds the Beach Day composite score.
    weightPct: null,
    explainer:
      "Portuguese man-o'-war carry a gas-filled float above the water, so unlike most jellyfish they're " +
      "driven directly by wind: sustained wind blowing straight onshore can push them up the beach, " +
      "typically within about a day. But wind alone can't tell whether any are offshore to begin with — " +
      "published stranding studies find wind-only estimates catch a real event only ~16–24% of the time — " +
      "so this reading is boosted when a live nearby sighting confirms them, and pulled back down when a " +
      "check finds none reported. Sea lice (seabather's eruption, from thimble jellyfish larvae) is a " +
      "completely separate, opposite-season story driven by warm water and Caribbean currents, not wind — " +
      "it's shown purely as a seasonal likelihood.",
    computation,
    sources: [
      "Open-Meteo hourly wind forecast — trailing ~24–36h of speed + direction at the beach",
      "iNaturalist community observations — Physalia physalis within ~100 km, last ~14 days",
      "Seasonal climatology — SE-FL man-o'-war season (Nov–Apr) and seabather's-eruption season (Mar–Aug, peak May–Jun)",
    ],
    notes:
      "This is an ADVISORY, not a validated forecast — a ~1-day horizon for man-o'-war and a seasonal " +
      "likelihood (not a day-specific prediction) for sea lice. Wind-only man-o'-war readings are capped " +
      "below the top band on purpose: without a confirmed sighting, wind can't tell you whether any are " +
      "actually offshore. Always defer to a lifeguard's purple (dangerous marine life) flag — it reflects " +
      "what's actually being seen on the sand right now.",
    formula:
      "onshore(hr) = windMph × max(0, cos(windFromDeg − coastNormalDeg)); sustained = recency-weighted " +
      "mean over the trailing 24–36h (needs ≥24h of coverage). Elevated anchor ≈ 8 m/s (~18 mph) sustained " +
      "onshore, tapered ×0.4 outside Nov–Apr. A sighting ≤7 days old and ≤100 km away raises confidence to " +
      "'observed' and lifts the score; a checked-and-empty feed lowers confidence to 'low' and damps it; a " +
      "down feed stays 'wind-only' and is capped below 'high'. Sea lice: in-window (Mar–Aug) baseline, +1 " +
      "tier for the May–Jun peak, +1 tier for water ≥78°F.",
  };
}

export interface MarineStingerCardProps {
  manOWar: ManOWarRisk | null;
  seaLice: SeaLiceRisk | null;
}

/**
 * Exception-only marine-stinger advisory: Portuguese man-o'-war stranding risk
 * (wind + season + live sightings) and, when in season, a secondary seabather's-
 * eruption ("sea lice") note. Mirrors the tide-aberration badges' philosophy —
 * a "low"/off-season reading is quiet (renders nothing) so this card only ever
 * takes up room when it genuinely has something to say. Props-driven and
 * self-contained: pass the outputs of lib/marineStinger.ts directly.
 *
 * SCOPE: the man-o'-war science this card presents (onshore-wind stranding,
 * Nov-Apr season) is SE-Florida/Atlantic-specific. Callers should only ever
 * compute `manOWar` (i.e. only pass a real `coastNormalDeg`) for a beach on a
 * man-o'-war-prone Atlantic-facing coast — elsewhere, pass `manOWar: null` so
 * the card degrades to sea-lice-only-or-nothing rather than showing an
 * advisory that doesn't apply to that shoreline.
 */
export function MarineStingerCard({ manOWar, seaLice }: MarineStingerCardProps) {
  const showManOWar = !!manOWar && manOWar.level !== "low";
  const showSeaLice = !!seaLice && seaLice.level !== "low";

  // Quiet, exception-only advisory: nothing worth flagging today -> render nothing.
  if (!showManOWar && !showSeaLice) return null;

  // One slim strip PER active advisory (see components/AdvisoryStrip.tsx) —
  // stacked when both speak, and no empty half of a card grid when only one
  // does. Both share the same science note, which is what the flip back was.
  const note = <NerdBack info={buildInfo(manOWar, seaLice)} />;

  return (
    <>
      {showManOWar ? (
        <AdvisoryStrip
          icon="🪼"
          label="man-o’-war advisory"
          headline={`${MAN_O_WAR_LABEL[manOWar!.level]} man-o’-war advisory`}
          headlineClass={MAN_O_WAR_TONE[manOWar!.level]}
          detail={manOWar!.note}
          pill={{
            label: confidenceLabel(manOWar!.confidence),
            tone: CONFIDENCE_BADGE[manOWar!.confidence].tone,
          }}
          note={note}
        />
      ) : null}
      {showSeaLice ? (
        <AdvisoryStrip
          icon="🦠"
          label="sea-lice advisory"
          headline={`${SEA_LICE_LABEL[seaLice!.level]} sea-lice season`}
          headlineClass={SEA_LICE_TONE[seaLice!.level]}
          detail={seaLice!.note}
          note={note}
        />
      ) : null}
    </>
  );
}
