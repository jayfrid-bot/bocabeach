"use client";

import { useState } from "react";
import type { ScoreResult, SubScore } from "@/lib/types";
import { scoreColor, scoreTextClass } from "@/lib/format";

// viewBox geometry. The donut leaves a wide center hole for the score.
const SIZE = 340;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_OUT = 150;
const R_IN = 92;
const R_OUT_SEL = 158; // the selected slice pops outward
const LABEL_R = (R_OUT + R_IN) / 2;

/** Emoji shown on a slice when it's wide enough to carry one. */
const FACTOR_EMOJI: Record<string, string> = {
  airTemp: "🌡️",
  sky: "☀️",
  wind: "🌬️",
  waterTemp: "🌊",
  waves: "🏄",
  comfort: "💧",
  sandTemp: "🦶",
  sargassum: "🌿",
  waterQuality: "🧪",
  crowds: "👥",
  uv: "🕶️",
};

/** Plain-English "what it measures + how it's calculated" per factor. */
const FACTOR_EXPLAIN: Record<string, string> = {
  airTemp:
    "Air temperature right now — the median across NWS station observations, MET Norway, Open-Meteo and GFS, so no single model can skew it. Low-to-mid 80s°F scores best; colder or hotter tapers off.",
  sky:
    "Sunshine and dryness blended: cloud cover drives the sunny feel, rain chance and any active weather pull it down. Full sun with no rain in sight ≈ 100; storms clamp it hard.",
  wind:
    "Wind speed (median across sources). A 5–13 mph sea breeze is the sweet spot — dead calm turns muggy and buggy, while 20+ mph chop blows sand and whitecaps the water.",
  waterTemp:
    "Ocean temperature from the nearest NOAA buoy (marine model as fallback). Mid-80s water is dream swimming; below ~70°F gets bracing fast.",
  waves:
    "Wave height from the buoy / marine model. Under about a foot is calm, easy swimming; every extra foot of surf costs points.",
  comfort:
    "How muggy it feels, from the dew point (derived from the same consensus temperature and humidity shown on the cards). Dew point under ~65°F feels crisp; 75°F+ is oppressive.",
  sandTemp:
    "Estimated dry-sand surface temperature, modeled from ground temp, solar radiation, wind, recent rain and cloud cover — calibrated against real on-beach IR-thermometer readings.",
  sargassum:
    "Seaweed on the beach, read live from the beach cams by AI vision and scored point-in-time (the beach gets credit as soon as it's cleaned). Very heavy coverage (50%+) puts a sliding ceiling on the whole score — bottoming out at 70 once coverage hits ~90%.",
  waterQuality:
    "Official water-quality ratings and advisories for this beach. An active advisory doesn't just lower this slice — it caps the whole score.",
  crowds:
    "How busy the sand is, read live from the beach cams. Quieter beach, higher score.",
  uv:
    "The current UV index. High UV only trims a little — it mostly means bring sunscreen — but extreme UV trims more.",
};

interface Slice {
  sub: SubScore;
  /** Renormalized weight share (0-1) among the factors that have data. */
  share: number;
  startDeg: number;
  endDeg: number;
  color: string;
}

const rad = (deg: number) => ((deg - 90) * Math.PI) / 180; // 0° at 12 o'clock
// Coordinates are rounded to 2 decimals so the server-rendered SVG and the
// client hydration agree exactly (raw float trig can differ in the last digit
// between the two passes → a React hydration-mismatch warning).
const round2 = (v: number) => Math.round(v * 100) / 100;
const pt = (r: number, deg: number) => ({
  x: round2(CX + r * Math.cos(rad(deg))),
  y: round2(CY + r * Math.sin(rad(deg))),
});

/** SVG path for one donut slice from startDeg to endDeg. */
function slicePath(startDeg: number, endDeg: number, rOut: number): string {
  const large = endDeg - startDeg > 180 ? 1 : 0;
  const a = pt(rOut, startDeg);
  const b = pt(rOut, endDeg);
  const c = pt(R_IN, endDeg);
  const e = pt(R_IN, startDeg);
  return [
    `M${a.x.toFixed(2)} ${a.y.toFixed(2)}`,
    `A${rOut} ${rOut} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`,
    `L${c.x.toFixed(2)} ${c.y.toFixed(2)}`,
    `A${R_IN} ${R_IN} 0 ${large} 0 ${e.x.toFixed(2)} ${e.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/**
 * The Beach Day score as an interactive donut: every factor is a slice sized by
 * its weight in the score and colored by how well it's doing right now. Tap a
 * slice for what that factor measures, its live reading, how it's calculated,
 * and exactly how many points it's adding to — or costing — the score.
 */
export function ScoreWheel({ result }: { result: ScoreResult }) {
  const [selected, setSelected] = useState<string | null>(null);

  // Only factors with data get a slice; renormalize their weights to the full
  // circle (the same renormalization the score itself uses when data is missing).
  const withData = result.subScores.filter((s) => s.score != null);
  const totalW = withData.reduce((a, s) => a + s.weight, 0);
  if (!withData.length || totalW <= 0) return null;

  const GAP = 1.6; // degrees of breathing room between slices
  let cursor = 0;
  const slices: Slice[] = withData.map((sub) => {
    const span = (sub.weight / totalW) * 360;
    const s: Slice = {
      sub,
      share: sub.weight / totalW,
      startDeg: cursor + GAP / 2,
      endDeg: cursor + span - GAP / 2,
      color: scoreColor(sub.score as number),
    };
    cursor += span;
    return s;
  });

  const sel = slices.find((s) => s.sub.key === selected) ?? null;
  const capped = result.caps.length > 0 && result.score < result.rawScore;

  // Impact math for the detail card: this factor's weight share of 100 points,
  // how many of those points its current reading is contributing, and the gap.
  const detail = sel
    ? (() => {
        const possible = sel.share * 100;
        const contributed = sel.share * (sel.sub.score as number);
        return {
          possible: Math.round(possible * 10) / 10,
          contributed: Math.round(contributed * 10) / 10,
          lost: Math.round((possible - contributed) * 10) / 10,
        };
      })()
    : null;

  const toggle = (key: string) => setSelected((k) => (k === key ? null : key));

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-slate-900 dark:text-white">
        What&apos;s making the score
      </h2>
      <p className="mb-3 text-xs text-slate-500">
        Every slice is one factor — sized by how much it counts, colored by how
        it&apos;s doing right now. Tap a slice for the full story.
      </p>

      <div className="rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
        <svg
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="mx-auto w-full max-w-sm"
          role="group"
          aria-label="Beach Day score factors"
        >
          {slices.map((s) => {
            const isSel = s.sub.key === selected;
            const mid = (s.startDeg + s.endDeg) / 2;
            const span = s.endDeg - s.startDeg;
            const label = pt(LABEL_R, mid);
            return (
              <g key={s.sub.key}>
                <path
                  d={slicePath(s.startDeg, s.endDeg, isSel ? R_OUT_SEL : R_OUT)}
                  fill={s.color}
                  opacity={selected && !isSel ? 0.35 : 1}
                  stroke={isSel ? "currentColor" : "none"}
                  strokeWidth={isSel ? 2.5 : 0}
                  // outline-none drops the browser's rectangular focus ring (the
                  // "blue square" around the slice's bounding box); keyboard users
                  // still get a visible indicator via the focus-visible stroke,
                  // which matches the selected-slice outline.
                  className="cursor-pointer text-slate-900 outline-none transition-opacity focus-visible:[stroke:currentColor] focus-visible:[stroke-width:2.5] dark:text-white"
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSel}
                  aria-label={`${s.sub.label}: ${s.sub.score} out of 100, ${Math.round(
                    s.share * 100,
                  )}% of the score${s.sub.display ? ` (${s.sub.display})` : ""}`}
                  onClick={() => toggle(s.sub.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggle(s.sub.key);
                    }
                  }}
                />
                {span > 16 ? (
                  <text
                    x={label.x}
                    y={label.y}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize="16"
                    className="pointer-events-none select-none"
                    aria-hidden
                  >
                    {FACTOR_EMOJI[s.sub.key] ?? ""}
                  </text>
                ) : null}
              </g>
            );
          })}

          {/* center: the score itself */}
          <g
            className={selected ? "cursor-pointer" : undefined}
            onClick={() => setSelected(null)}
          >
            <circle cx={CX} cy={CY} r={R_IN - 6} fill="transparent" />
            <text
              x={CX}
              y={CY - 12}
              textAnchor="middle"
              fontSize="52"
              fontWeight="700"
              fill={scoreColor(result.score)}
            >
              {result.score}
            </text>
            <text
              x={CX}
              y={CY + 22}
              textAnchor="middle"
              fontSize="15"
              className="fill-slate-600 dark:fill-slate-300"
            >
              {result.rating}
            </text>
            {capped ? (
              <text
                x={CX}
                y={CY + 42}
                textAnchor="middle"
                fontSize="11"
                className="fill-amber-600 dark:fill-amber-400"
              >
                capped from {result.rawScore}
              </text>
            ) : null}
          </g>
        </svg>

        {/* detail card for the tapped slice */}
        {sel && detail ? (
          <div className="mt-3 rounded-xl bg-slate-100/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-800/60 dark:ring-white/10">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900 dark:text-white">
                <span aria-hidden className="mr-1.5">
                  {FACTOR_EMOJI[sel.sub.key]}
                </span>
                {sel.sub.label}
              </h3>
              <span className={`text-sm font-bold ${scoreTextClass(sel.sub.score as number)}`}>
                {sel.sub.score}/100
                {sel.sub.display ? (
                  <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                    {sel.sub.display}
                  </span>
                ) : null}
              </span>
            </div>

            <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-400">
              {FACTOR_EXPLAIN[sel.sub.key] ?? ""}
            </p>

            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              <span className="rounded-full bg-slate-200/80 px-2.5 py-1 text-slate-700 dark:bg-slate-700/60 dark:text-slate-200">
                {Math.round(sel.share * 100)}% of the score
              </span>
              <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-700 ring-1 ring-emerald-500/20 dark:text-emerald-400">
                adding {detail.contributed} of {detail.possible} possible pts
              </span>
              {detail.lost >= 1 ? (
                <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-400">
                  costing {detail.lost} pts
                </span>
              ) : (
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-emerald-700 ring-1 ring-emerald-500/20 dark:text-emerald-400">
                  near-perfect right now
                </span>
              )}
            </div>

            {capped ? (
              <p className="mt-3 text-[11px] leading-relaxed text-amber-700 dark:text-amber-400">
                Note: a safety/quality cap is overriding the weighted math today
                ({result.caps.join("; ")}) — the score is held at {result.score}{" "}
                regardless of these points.
              </p>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-center text-[11px] text-slate-400 dark:text-slate-600">
            tap a slice to see how it&apos;s calculated and what it&apos;s worth
          </p>
        )}
      </div>
    </section>
  );
}
