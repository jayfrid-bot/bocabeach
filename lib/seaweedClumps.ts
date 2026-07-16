// Deterministic wrack-line layout for SeaweedStrip's aerial beach scene: the
// strip is a top-down slice of beach (water at the top, sand below), and the
// seaweed accumulates along a gently wavy WRACK LINE parallel to the water's
// edge — which is what the cam-vision captions literally describe ("dense
// sargassum band along the water's edge").
//
// Coverage % drives DENSITY and THICKNESS of that band, spread across the
// FULL width — never packed to one side, because a coverage % means "this
// fraction of the beach is covered", not "the left part of it". Everything is
// seeded (mulberry32) — no Math.random()/Date.now() at render — so SSR and
// the client produce pixel-identical output.

import { clamp } from "@/lib/util";

// ---------------------------------------------------------------------------
// Scene geometry (viewBox px). The strip stretches to the card's CSS box via
// preserveAspectRatio="none", so these are coordinate-scale numbers only.
// ---------------------------------------------------------------------------

export const STRIP_W = 400;
export const STRIP_H = 64;

/** Mean y of the scalloped foam edge where water meets sand (~22% down). */
export const WATERLINE_Y = 14;
/** Bottom of the darker wet-sand strip under the waterline. */
export const WET_SAND_BOTTOM_Y = 22;

/** Front-row slots along the wrack line (fills completely at 100%). */
export const FRONT_SLOTS = 24;
/** Back-row slots that thicken the band into a mat above ~50% coverage. */
export const BACK_SLOTS = 12;

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------

/** Small deterministic PRNG (mulberry32) — same seed always yields the same
 * output, so layout is a pure function of its inputs, never wall-clock state. */
function seededRand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Round to 1 decimal — keeps SSR/client SVG attribute strings identical. */
const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;

/** Reverses the low `bits` bits of `value` — e.g. bitReverse(0b001, 3) === 0b100. */
function bitReverse(value: number, bits: number): number {
  let result = 0;
  for (let b = 0; b < bits; b++) {
    result = (result << 1) | ((value >> b) & 1);
  }
  return result;
}

/**
 * Deterministic order in which slots "reveal" as coverage % rises — the
 * base-2 van der Corput sequence (bit-reversed fractions 0, 1/2, 1/4, 3/4,
 * 1/8, 5/8…) mapped onto slot indices, the same low-discrepancy technique
 * progressive image formats use so that ANY prefix of the sequence is already
 * spread roughly evenly across the full range, not clustered at one end.
 * Fractions (not bit-reversed slot indices) so the spread stays even when
 * `slots` isn't a power of two; collisions probe to the next free slot.
 * No randomness: same `slots` always yields the same order.
 */
export function wrackRevealOrder(slots: number): number[] {
  const bits = Math.max(1, Math.ceil(Math.log2(slots)));
  const denom = 1 << bits;
  const taken = new Array<boolean>(slots).fill(false);
  const order: number[] = [];
  for (let k = 0; k < denom && order.length < slots; k++) {
    const frac = bitReverse(k, bits) / denom;
    let slot = Math.min(slots - 1, Math.floor(frac * slots));
    while (taken[slot]) slot = (slot + 1) % slots;
    taken[slot] = true;
    order.push(slot);
  }
  return order;
}

// ---------------------------------------------------------------------------
// The wavy wrack line
// ---------------------------------------------------------------------------

const WRACK_BASE_Y = 33;
const WRACK_WAVE_AMP = 3.5;
const WRACK_WAVE_LEN = 170;

/** y of the wrack line at x (px) — gently wavy, parallel-ish to the water,
 * never ruler-straight. Pure function; used for stamp placement. */
export function wrackLineY(x: number): number {
  return WRACK_BASE_Y + WRACK_WAVE_AMP * Math.sin((2 * Math.PI * x) / WRACK_WAVE_LEN + 0.8);
}

// ---------------------------------------------------------------------------
// Coverage → density (the honesty contract)
// ---------------------------------------------------------------------------

/**
 * How many clump stamps a coverage % produces, split into the main front row
 * (fills 0→100%) and the back row that only starts stacking above 50% — which
 * is what turns "a patchy band" into "a thick mat" instead of just more dots:
 *   0%   → 0        (clean sand — the scene still renders)
 *   15%  → 4        (sparse separated tufts)
 *   40%  → 10       (a broken, patchy band)
 *   70%  → 17 + 5   (thick, nearly continuous, band grows taller)
 *   100% → 24 + 12  (a solid blanket; only slivers of sand show)
 */
export function coverageToStampCounts(coveragePct: number): {
  front: number;
  back: number;
  total: number;
} {
  const pct = clamp(coveragePct, 0, 100);
  const front = Math.round((pct / 100) * FRONT_SLOTS);
  const back = Math.round((Math.max(0, pct - 50) / 50) * BACK_SLOTS);
  return { front, back, total: front + back };
}

// ---------------------------------------------------------------------------
// Stamp layout
// ---------------------------------------------------------------------------

export interface WrackStamp {
  /** Stable render key, unique across both rows. */
  key: string;
  row: "front" | "back";
  /** Slot index within its row, 0-based left to right. */
  slot: number;
  /** Which hand-authored clump silhouette (0-2). */
  variant: number;
  /** Stamp center, viewBox px. */
  x: number;
  y: number;
  /** Uniform scale on the silhouette's local coordinates. */
  scale: number;
  /** Mirror horizontally. */
  flip: boolean;
  /** Body-tone index (0-2) — the component maps it to light/dark fills. */
  tone: number;
}

const FRONT_SLOT_W = STRIP_W / FRONT_SLOTS;
const BACK_SLOT_W = STRIP_W / BACK_SLOTS;

/** Coverage-driven size multiplier: clumps swell as the band thickens, so a
 * heavy day reads taller/denser, not just "more dots of the same size". */
function coverageScale(pct: number): number {
  return 0.85 + 0.45 * (clamp(pct, 0, 100) / 100);
}

function frontStamp(slot: number, pct: number): WrackStamp {
  const rJx = seededRand(slot * 11 + 1);
  const rJy = seededRand(slot * 11 + 2);
  const rSize = seededRand(slot * 11 + 3);
  const rVar = seededRand(slot * 11 + 4);
  const rFlip = seededRand(slot * 11 + 5);
  const rTone = seededRand(slot * 11 + 6);
  const x = slot * FRONT_SLOT_W + FRONT_SLOT_W / 2 + (rJx - 0.5) * FRONT_SLOT_W * 0.5;
  const y = wrackLineY(x) + (rJy - 0.5) * 5;
  return {
    key: `f${slot}`,
    row: "front",
    slot,
    variant: Math.floor(rVar * 3) % 3,
    x: round1(x),
    y: round1(clamp(y, 27, 44)),
    scale: round2((0.72 + rSize * 0.5) * coverageScale(pct)),
    flip: rFlip > 0.5,
    tone: Math.floor(rTone * 3) % 3,
  };
}

function backStamp(slot: number, pct: number): WrackStamp {
  const rJx = seededRand(slot * 17 + 101);
  const rJy = seededRand(slot * 17 + 102);
  const rSize = seededRand(slot * 17 + 103);
  const rVar = seededRand(slot * 17 + 104);
  const rFlip = seededRand(slot * 17 + 105);
  const rTone = seededRand(slot * 17 + 106);
  const x = slot * BACK_SLOT_W + BACK_SLOT_W / 2 + (rJx - 0.5) * BACK_SLOT_W * 0.4;
  // Alternate above/below the front row so the mat thickens both ways.
  const side = slot % 2 === 0 ? -8 : 8;
  const y = wrackLineY(x) + side + (rJy - 0.5) * 4;
  return {
    key: `b${slot}`,
    row: "back",
    slot,
    variant: Math.floor(rVar * 3) % 3,
    x: round1(x),
    y: round1(clamp(y, 25, 51)),
    scale: round2((0.6 + rSize * 0.4) * coverageScale(pct)),
    flip: rFlip > 0.5,
    tone: Math.floor(rTone * 3) % 3,
  };
}

/**
 * The full stamp list for a coverage % — a pure, deterministic function of
 * `coveragePct` alone. Revealed slots come from `wrackRevealOrder`, so ANY
 * partial coverage is spread evenly across the strip's full width (a
 * left-packed fill would visually claim "the seaweed is on the left part of
 * the beach", which a coverage % never says). Stamps are sorted by y so
 * lower-on-screen (closer) clumps paint over the ones behind them.
 */
export function wrackLayout(coveragePct: number): WrackStamp[] {
  const { front, back } = coverageToStampCounts(coveragePct);
  const stamps: WrackStamp[] = [
    ...wrackRevealOrder(BACK_SLOTS)
      .slice(0, back)
      .map((slot) => backStamp(slot, coveragePct)),
    ...wrackRevealOrder(FRONT_SLOTS)
      .slice(0, front)
      .map((slot) => frontStamp(slot, coveragePct)),
  ];
  return stamps.sort((a, b) => a.y - b.y || a.x - b.x);
}

// ---------------------------------------------------------------------------
// Level fallback (unchanged contract)
// ---------------------------------------------------------------------------

/**
 * Representative coverage % to show when only a category level is known (no
 * measured coveragePct) — matches the SEAWEED_FALLBACK_PCT the score's sliding
 * ceiling uses in lib/score.ts's applyBeachCaps, so the graphic never implies a
 * different heaviness than what actually drove the score.
 */
export const SEAWEED_LEVEL_FALLBACK_PCT: Record<string, number> = {
  none: 0,
  low: 15,
  moderate: 40,
  high: 70,
};
