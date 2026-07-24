"use client";

import { useState } from "react";
import type { ScoreResult, SubScore } from "@/lib/types";
import { scoreColor, scoreTextClass } from "@/lib/format";

// viewBox geometry. The donut leaves a wide center hole for the score.
const SIZE = 340;
const CX = SIZE / 2;
const CY = SIZE / 2;
export const R_OUT = 150;
export const R_IN = 92;
const R_OUT_SEL = 158; // the selected slice pops outward
export const LABEL_R = (R_OUT + R_IN) / 2;
export const GAP = 1.6; // degrees of breathing room between slices

/** Small neutral header emoji for the tap-detail card (NOT the slices). */
const FACTOR_EMOJI: Record<string, string> = {
  airTemp: "🌡️",
  sky: "☀️",
  wind: "🌬️",
  waterTemp: "🌊",
  waves: "🏄",
  comfort: "💧",
  sandTemp: "🦶",
  sargassum: "🌿",
  crowds: "👥",
  uv: "🕶️",
};

/** Short TEXT label carried on the slice itself (replaces the old slice emoji). */
const FACTOR_LABEL: Record<string, string> = {
  airTemp: "Air",
  sky: "Sky",
  wind: "Wind",
  waterTemp: "Water",
  waves: "Waves",
  comfort: "Humidity",
  sandTemp: "Sand",
  sargassum: "Seaweed",
  crowds: "Crowds",
  uv: "UV",
};

/** Shorter fallback for factors whose full FACTOR_LABEL word doesn't fit a
 *  narrow slice's arc even at LABEL_FONT — tried before resorting to a radial
 *  orientation or the font floor. Factors not listed here don't need one (their
 *  full label already fits every slice width their weight can produce). */
const FACTOR_ABBREV: Record<string, string> = {
  comfort: "Humid",
  // No shortened form — "Seaweed" is the product's word (owner: never "Algae");
  // when it can't fit along the arc the plan falls through to a radial spoke,
  // where the full word fits comfortably.
  sargassum: "Seaweed",
  crowds: "Busy",
};

// Slice-label typography. Dark slate text with a white paint-order halo reads
// cleanly on every slice fill (emerald / lime / amber / rose) in both themes,
// since the slice colors are theme-independent.
const LABEL_FONT = 11.5;
// Deterministic width estimate for the fit test (must be SSR-safe — no DOM
// measuring). ~6.5px of arc per character plus end padding; a slice only gets
// its label when the arc at the label radius can hold the whole word without
// crowding the slice edges.
const LABEL_CHAR_W = 6.5;
const LABEL_PAD = 9;
/** Smallest font size a slice label is ever allowed to shrink to. */
const LABEL_FONT_FLOOR = 8;
/** Radial band width available to a label oriented along the spoke (outward
 *  from the hole) instead of along the arc — same donut ring every slice's
 *  tangential label lives in, so a radial label never leaves its own slice's
 *  color to sit over a neighbor. */
const RADIAL_BAND = R_OUT - R_IN;

/** True when `text` fits in `available` px at `fontSize`, per the same
 *  deterministic px/char estimate LABEL_CHAR_W encodes at LABEL_FONT. */
function labelFits(text: string, available: number, fontSize: number): boolean {
  if (!text) return false;
  const charW = LABEL_CHAR_W * (fontSize / LABEL_FONT);
  return available >= text.length * charW + LABEL_PAD;
}

/** Rotate `deg` (already the "reads correctly" orientation, e.g. tangential =
 *  mid, radial = mid+90) into the (-90, 90] range so the glyph is never
 *  upside down on the bottom/left half of the wheel. */
function uprightRotation(deg: number): number {
  const norm = ((deg % 360) + 360) % 360;
  return round2(norm > 90 && norm < 270 ? deg + 180 : deg);
}

export interface LabelPlan {
  text: string;
  radial: boolean;
  fontSize: number;
  rot: number;
}

/**
 * Deterministic (SSR-stable) plan for a slice's label: try the full word
 * tangentially, then the abbreviation tangentially, then either word oriented
 * radially (a spoke pointing out from the hole needs far less arc — only its
 * own font height, not its full text width), and finally fall back to the
 * abbreviation at the font floor, radially, which is never skipped — every
 * slice always gets readable text, however tight.
 */
export function planLabel(key: string, mid: number, arcLen: number): LabelPlan {
  const full = FACTOR_LABEL[key] ?? "";
  const abbrev = FACTOR_ABBREV[key] ?? full;
  const tangentRot = uprightRotation(mid);
  const radialRot = uprightRotation(mid + 90);

  const candidates: { text: string; radial: boolean; fontSize: number }[] = [
    { text: full, radial: false, fontSize: LABEL_FONT },
    { text: abbrev, radial: false, fontSize: LABEL_FONT },
    { text: full, radial: true, fontSize: LABEL_FONT },
    { text: abbrev, radial: true, fontSize: LABEL_FONT },
  ];
  for (const c of candidates) {
    const available = c.radial ? RADIAL_BAND : arcLen;
    if (labelFits(c.text, available, c.fontSize)) {
      return { text: c.text, radial: c.radial, fontSize: c.fontSize, rot: c.radial ? radialRot : tangentRot };
    }
  }
  // Guaranteed last resort — the font floor plus the generous radial band
  // fits every abbreviation the app ships today, but this branch renders
  // regardless so no slice is ever left blank.
  return { text: abbrev, radial: true, fontSize: LABEL_FONT_FLOOR, rot: radialRot };
}

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

  // Center block: score number (hero) + rating (+ optional "capped from N"),
  // laid out as ONE group that is optically centered in the donut hole. Each
  // line reserves a fixed box height; we stack the boxes and center the whole
  // stack on CY, so the capped line's presence never shifts the number off
  // center — it just rebalances the group. dominant-baseline "central" then
  // centers each line on its box center.
  const centerLines: {
    key: string;
    box: number; // reserved vertical space for this line
    size: number;
    weight?: number;
    fill?: string;
    className?: string;
    text: string;
  }[] = [
    {
      key: "score",
      box: 48,
      size: 54,
      weight: 700,
      fill: scoreColor(result.score),
      text: String(result.score),
    },
    {
      key: "rating",
      box: 20,
      size: 15,
      className: "fill-slate-600 dark:fill-slate-300",
      text: result.rating,
    },
  ];
  if (capped) {
    centerLines.push({
      key: "capped",
      box: 15,
      size: 11,
      className: "fill-amber-600 dark:fill-amber-400",
      text: `capped from ${result.rawScore}`,
    });
  }
  const centerTotalH = centerLines.reduce((a, l) => a + l.box, 0);
  let centerY = CY - centerTotalH / 2;
  const centerRows = centerLines.map((l) => {
    const y = round2(centerY + l.box / 2);
    centerY += l.box;
    return { ...l, y };
  });

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
            const at = pt(LABEL_R, mid);
            // Every slice gets readable text: tangential (arc-following) when
            // the word fits the arc at LABEL_R, else a radial spoke (needs
            // only font-height worth of arc, not the word's full width), with
            // an abbreviation and a font floor as further fallbacks — see
            // planLabel. Deterministic px/char estimate, no DOM measuring, so
            // SSR and hydration always agree.
            const arcLen = (span * Math.PI) / 180 * LABEL_R;
            const label = planLabel(s.sub.key, mid, arcLen);
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
                <text
                  x={at.x}
                  y={at.y}
                  transform={`rotate(${label.rot} ${at.x} ${at.y})`}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={label.fontSize}
                  fontWeight={500}
                  fill="#0f172a"
                  stroke="#ffffff"
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  paintOrder="stroke"
                  opacity={selected && !isSel ? 0.35 : 1}
                  className="pointer-events-none select-none transition-opacity"
                  aria-hidden
                >
                  {label.text}
                </text>
              </g>
            );
          })}

          {/* center: the score itself — one optically centered block */}
          <g
            className={selected ? "cursor-pointer" : undefined}
            onClick={() => setSelected(null)}
          >
            <circle cx={CX} cy={CY} r={R_IN - 6} fill="transparent" />
            {centerRows.map((l) => (
              <text
                key={l.key}
                x={CX}
                y={l.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={l.size}
                fontWeight={l.weight}
                fill={l.fill}
                className={l.className}
              >
                {l.text}
              </text>
            ))}
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
