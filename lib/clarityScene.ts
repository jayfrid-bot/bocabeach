// Pure mapping helpers behind components/ClarityScene.tsx — the "can you see
// the bottom" water column on the Water clarity tile. The visual claim is
// simple and worth testing on its own: clarity IS visibility, so a lower clear
// percentage means MORE haze between you and the seafloor, and more junk
// suspended in the water.

import { clamp } from "@/lib/util";

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Even crystal-clear water isn't optically empty — a floor keeps the scene
 *  honest (and keeps the haze layer from disappearing into a hard edge). */
const HAZE_MIN = 0.05;
/** The murkiest reading still shows a ghost of the fish rather than a solid
 *  brown block — a ceiling below 1 keeps the scene readable as water. */
const HAZE_MAX = 0.75;

/** Turbidity of the water column, 0.05 (crystal) → 0.75 (churned), linear in
 *  the murk fraction (100 − pct)/100. */
export function clarityHazeOpacity(pct: number): number {
  const murk = (100 - clamp(pct, 0, 100)) / 100;
  return round2(HAZE_MIN + murk * (HAZE_MAX - HAZE_MIN));
}

/** Suspended particles rise with the murk: a couple of motes in clear water,
 *  a swarm in churned water. */
export function clarityParticleCount(pct: number): number {
  const murk = (100 - clamp(pct, 0, 100)) / 100;
  return Math.round(2 + murk * 22);
}

/**
 * Radical inverse (van der Corput) in `base` — a low-discrepancy sequence that
 * scatters points evenly without ever clumping. Used instead of Math.random so
 * the particle field is identical on the server and after hydration, the same
 * discipline the wave/tide scenes follow with pure trig.
 */
export function radicalInverse(i: number, base: number): number {
  let result = 0;
  let denom = 1;
  let n = i;
  while (n > 0) {
    denom *= base;
    result += (n % base) / denom;
    n = Math.floor(n / base);
  }
  return result;
}

export interface ClarityParticle {
  x: number;
  y: number;
  r: number;
  o: number;
}

/**
 * The suspended-particle field for a clarity reading, in the scene's
 * 280×56 viewBox. Count and opacity both scale with the murk; positions come
 * from co-prime van der Corput bases so they're deterministic AND look
 * scattered rather than gridded.
 */
export function clarityParticles(pct: number, width = 280, height = 56): ClarityParticle[] {
  const murk = (100 - clamp(pct, 0, 100)) / 100;
  const count = clarityParticleCount(pct);
  const out: ClarityParticle[] = [];
  for (let i = 1; i <= count; i++) {
    out.push({
      x: round2(4 + radicalInverse(i, 2) * (width - 8)),
      // Kept off the very top so particles read as "in the water", not on the
      // surface line, and off the floor so they don't merge with the sand.
      y: round2(7 + radicalInverse(i, 3) * (height - 18)),
      r: round2(0.5 + radicalInverse(i, 5) * 1.1),
      o: round2(0.2 + murk * 0.5),
    });
  }
  return out;
}
