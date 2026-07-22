// ---------------------------------------------------------------------------
// Feels-like beach temperature — the square instrument card + its flip-card
// "data nerd" back, built entirely on top of lib/feelsLikeBeach.ts.
//
// Self-contained by design: every input arrives as an explicit prop (the same
// field names/units lib/types.ts's ConditionsSnapshot/Derived already use —
// airTempF °F, humidityPct %, windSpeedMph mph, cloudCoverPct 0-100%,
// sandTempF °F), so this card has no dependency on lib/conditions.ts or any
// data-fetching layer. A caller (e.g. ConditionsDashboard) just derives those
// values from its own snapshot and passes them straight through.
//
// Conventions matched deliberately, per the other instrument cards:
//  - MetricCard's "square widget" shape (icon+label row, centered value block,
//    reserved sub-line) for the no-data fallback and general front layout —
//    see components/MetricCard.tsx / components/UvCard.tsx.
//  - FlipCard + NerdBack (components/FlipCard.tsx) for the tap-to-flip "how we
//    compute this" back: explainer → right now → sources → formula, same
//    order and section labels every other card's back uses (lib/nerdInfo.ts's
//    builders). These are generic, reusable UI primitives — reusing them
//    (not reimplementing the flip) is what "matching conventions exactly"
//    means here; it is not a dependency on lib/conditions.ts.
//  - Tone colors/classes from lib/feelsLikeBeach.ts's feelsLikeBandInfo, which
//    deliberately reuses the exact hex palette lib/sandTemp.ts's sandVerdict
//    uses and the light/dark Tailwind text-class convention lib/scoreBands.ts
//    uses, so this reads as the same visual language as the rest of the app.
// ---------------------------------------------------------------------------

import type { NerdInfo } from "@/lib/nerdInfo";
import {
  feelsLikeBand,
  feelsLikeBandInfo,
  feelsLikeBeach,
  heatIndexF,
  sandRadiantF,
  solarRadiantF,
  windCoolingF,
  type FeelsLikeInput,
} from "@/lib/feelsLikeBeach";
import { MetricCard } from "@/components/MetricCard";
import { FlipCard, NerdBack } from "@/components/FlipCard";

const r0 = (n: number) => Math.round(n);

export interface FeelsLikeCardProps extends FeelsLikeInput {
  /** Compact mode drops the driver line — for tight layouts. Defaults to false. */
  compact?: boolean;
}

/** The plain square front tile: temperature + band + top drivers. */
function FeelsLikeFront({
  tempF,
  band,
  drivers,
  compact,
}: {
  tempF: number;
  band: ReturnType<typeof feelsLikeBand>;
  drivers: string[];
  compact?: boolean;
}) {
  const info = feelsLikeBandInfo(band);
  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🥵</span>
        <span>Feels like</span>
      </div>
      {/* Centered value block, same "square widget" convention as MetricCard —
          extra vertical room reads as a deliberate widget, not dead space. */}
      <div className="flex flex-1 flex-col justify-center">
        <div className="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
          {tempF}°F
        </div>
        <div className={`text-xs font-medium ${info.textClass}`}>{info.label}</div>
        {!compact ? (
          <div className="mt-0.5 min-h-4 break-words text-xs text-slate-600 dark:text-slate-400 line-clamp-2">
            {drivers.length ? drivers.join(" · ") : " "}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The data-nerd back: how the number is built, right now, with real numbers. */
function buildFeelsLikeNerdInfo(input: FeelsLikeInput, tempF: number, band: string): NerdInfo {
  const { airTempF, humidityPct } = input;
  const base = airTempF != null && humidityPct != null ? heatIndexF(airTempF, humidityPct) : undefined;
  const solar = solarRadiantF({
    cloudCoverPct: input.cloudCoverPct,
    sunElevationDeg: input.sunElevationDeg,
    solarWm2: input.solarWm2,
    isDaytime: input.isDaytime,
  });
  const sand = sandRadiantF(input.sandTempF, airTempF);
  const windCool = windCoolingF(input.windSpeedMph, humidityPct);

  const computation: string[] = [];
  computation.push(
    base != null
      ? `${airTempF}°F / ${humidityPct}% RH → NOAA heat index ${r0(base)}°F`
      : "No air temp / humidity — no feels-like reading right now.",
  );
  computation.push(
    solar > 0
      ? `+${r0(solar)}°F direct sun` +
          (input.cloudCoverPct != null ? ` (${input.cloudCoverPct}% cloud)` : "") +
          (input.sunElevationDeg != null ? `, sun ${r0(input.sunElevationDeg)}° up` : "")
      : input.isDaytime === false || (input.sunElevationDeg ?? 1) <= 0
        ? "+0°F sun load — after dark"
        : "+0°F sun load (fully overcast, or no cloud/sun data yet)",
  );
  computation.push(
    input.sandTempF != null
      ? `+${r0(sand)}°F off ${input.sandTempF}°F sand (vs ${airTempF}°F air)`
      : "+0°F sand load — no sand-temperature reading yet",
  );
  computation.push(
    input.windSpeedMph != null
      ? `−${r0(windCool)}°F wind cooling (${input.windSpeedMph} mph` +
          (humidityPct != null && humidityPct > 70 ? ", damped by humidity" : "") +
          ")"
      : "−0°F wind cooling — no wind reading yet",
  );
  computation.push(`= ${tempF}°F feels-like → ${band}`);

  return {
    title: "Feels-like beach temperature",
    // Informational only — this card does not (yet) feed the Beach Day score.
    weightPct: null,
    explainer:
      "An on-the-towel comfort number that goes further than a weather app's heat index. It starts from the same NOAA heat index every forecast uses (air temperature + humidity), then adds what's unique to actually standing on a beach: direct sun radiating onto bare skin, and heat radiating back up off hot sand — and subtracts what a sea breeze gives back. A plain heat index can call a sunny, hot-sand afternoon merely 'warm' because it never looks past the shade; this number does.",
    formula:
      "feelsLikeF = heatIndex(airF, RH%) + solarTerm(≤8°F, ×(1−cloud/100)×sinElevation) + sandTerm((sandF−airF)×0.06, clamped 0–4°F) − windTerm(0.35°F/mph over 5 mph, capped 7°F, ×0.5 if RH>70%)",
    computation,
    sources: [
      "NOAA/NWS heat index — Rothfusz regression (Weather Prediction Center)",
      "Beach conditions: air temp, humidity, wind, cloud cover, sun position, and the estimated sand temperature (lib/sandTemp.ts) — the same inputs the other instrument cards use",
    ],
    notes:
      "First-guess calibration: the sun/sand/wind add-on terms are physically-reasoned starting points (see lib/feelsLikeBeach.ts's rationale comments), not yet field-calibrated the way the sand-temperature model is — expect the owner to tune these constants as real feedback comes in.",
  };
}

/**
 * Feels-like beach temperature card: a square instrument (front) plus a
 * tap-to-flip "how we compute this" back, matching every other dashboard
 * card's FlipCard/NerdBack convention. Falls back to the standard MetricCard
 * "not available" tile when air temp or humidity is missing (honest-null —
 * see feelsLikeBeach). Props-driven and self-contained: pass in whatever the
 * live snapshot has, in the same field names/units used elsewhere in the app.
 */
export function FeelsLikeCard(props: FeelsLikeCardProps) {
  const { compact, ...input } = props;
  const result = feelsLikeBeach(input);

  if (!result) {
    return (
      <FlipCard
        label="Feels like"
        front={<MetricCard icon="🥵" label="Feels like" value="—" sub="not available" />}
        back={
          <NerdBack
            info={{
              title: "Feels-like beach temperature",
              weightPct: null,
              explainer:
                "An on-the-towel comfort number that adds direct sun and hot-sand radiant heat on top of the standard NOAA heat index. It needs at least an air temperature and a humidity reading to compute anything — neither is available right now.",
              formula:
                "feelsLikeF = heatIndex(airF, RH%) + solarTerm + sandTerm − windTerm — see lib/feelsLikeBeach.ts",
              computation: ["No air temp / humidity reading — nothing to compute yet."],
              sources: ["NOAA/NWS heat index — Rothfusz regression (Weather Prediction Center)"],
            }}
          />
        }
      />
    );
  }

  const { tempF, band, drivers } = result;
  return (
    <FlipCard
      label="Feels like"
      front={<FeelsLikeFront tempF={tempF} band={band} drivers={drivers} compact={compact} />}
      back={<NerdBack info={buildFeelsLikeNerdInfo(input, tempF, band)} />}
    />
  );
}
