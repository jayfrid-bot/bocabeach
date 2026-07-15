// Deterministic seaweed-clump layout for SeaweedStrip: a fixed grid of "cells"
// across the strip's width, each with a fixed (seeded, not random-at-render)
// clump shape. Coverage % just decides how many cells (from the left) are
// "revealed" as seaweed — that literally makes covered cells span X% of the
// strip's width, and SSR/client always agree since nothing depends on
// Math.random() or Date.now().

import { clamp } from "@/lib/util";

export const CLUMP_CELLS = 20;

/** Olive/brown seaweed color variants, cycled per cell for visual texture. */
export const CLUMP_COLORS = ["#6b7a3a", "#5a6b2f", "#7c8f45", "#4f5c26"];

export interface ClumpShape {
  /** Cell index, 0-based left to right. */
  index: number;
  /** Ellipse center as a 0-1 fraction of the strip's width/height. */
  cx: number;
  cy: number;
  /** Ellipse radii as 0-1 fractions of the strip's width/height. */
  rx: number;
  ry: number;
  /** Rotation, degrees. */
  rot: number;
  color: string;
}

/** Small deterministic PRNG (mulberry32) — same seed always yields the same
 * output, so layout is a pure function of `seed`, not wall-clock/session state. */
function seededRand(seed: number): number {
  let t = (seed + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The full fixed set of clump shapes across `cells` slots (default 20). Pure
 * and deterministic — call it as many times as needed, always the same result.
 */
export function clumpLayout(cells: number = CLUMP_CELLS): ClumpShape[] {
  const cellW = 1 / cells;
  return Array.from({ length: cells }, (_, i) => {
    const rJitterX = seededRand(i * 7 + 1);
    const rJitterY = seededRand(i * 7 + 2);
    const rSize = seededRand(i * 7 + 3);
    const rSize2 = seededRand(i * 7 + 4);
    const rRot = seededRand(i * 7 + 5);
    return {
      index: i,
      cx: round2(i * cellW + cellW / 2 + (rJitterX - 0.5) * cellW * 0.3),
      cy: round2(0.5 + (rJitterY - 0.5) * 0.3),
      rx: round2(cellW * 0.55 * (0.7 + rSize * 0.6)),
      ry: round2(0.32 * (0.6 + rSize2 * 0.7)),
      rot: round2((rRot - 0.5) * 50),
      color: CLUMP_COLORS[i % CLUMP_COLORS.length],
    };
  });
}

/** How many of `cells` slots are "covered" for a coverage %. */
export function coverageToClumpCount(coveragePct: number, cells: number = CLUMP_CELLS): number {
  return Math.round((clamp(coveragePct, 0, 100) / 100) * cells);
}

/** Reverses the low `bits` bits of `value` — e.g. bitReverse(0b001, 3) === 0b100. */
function bitReverse(value: number, bits: number): number {
  let result = 0;
  for (let b = 0; b < bits; b++) {
    result = (result << 1) | ((value >> b) & 1);
  }
  return result;
}

/**
 * Deterministic order in which cell indices "reveal" as coverage % rises —
 * a bit-reversal (van der Corput-style) permutation, the same low-discrepancy
 * technique progressive image formats use so that ANY prefix of the sequence
 * is already spread roughly evenly across the full range, not clustered at
 * one end. No randomness: same `cells` always yields the same order.
 */
export function clumpRevealOrder(cells: number = CLUMP_CELLS): number[] {
  const bits = Math.max(1, Math.ceil(Math.log2(cells)));
  return Array.from({ length: cells }, (_, i) => i)
    .map((i) => ({ i, key: bitReverse(i, bits) }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((e) => e.i);
}

/**
 * Which cell indices are "covered" for a coverage % — spread across the
 * FULL width at density proportional to the %, not packed into the leftmost
 * X% of the strip. A left-packed fill visually reads as "the seaweed is on
 * the left part of the beach," which a coverage % never claims — it means
 * "this fraction of the beach is covered," with no information about where.
 * Same count as `coverageToClumpCount` (so the perceived covered area still
 * tracks the %), just spread via `clumpRevealOrder` instead of a left slice.
 */
export function coveredCellIndices(coveragePct: number, cells: number = CLUMP_CELLS): number[] {
  const n = coverageToClumpCount(coveragePct, cells);
  return clumpRevealOrder(cells)
    .slice(0, n)
    .sort((a, b) => a - b);
}

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
