// Pure mapping helpers behind components/SunsetScene.tsx — the mini "predicted
// sky" horizon scene on the Golden hour card. Kept out of the JSX so the
// data→visual decisions (which palette, where the sun sits) are testable and
// deterministic: same inputs → same output, on the server render and on
// hydration alike.

/** Which sky palette the forecast earns. Cutoffs are the card's own reading of
 *  lib/sunQuality.ts's score, deliberately coarser than BAND_CUTOFFS: a scene
 *  only has so many distinguishable looks. */
export type SkyTier = "vivid" | "warm" | "mild" | "dud" | "unknown";

/**
 * score >= 75 → vivid (amber→rose→purple), 50-74 → warm (amber→soft pink),
 * 25-49 → mild (pale amber→slate), < 25 → dud (gray-blue, almost colorless).
 * A null/absent/non-finite score is "unknown" — a neutral sky, never a
 * flattering guess.
 */
export function skyTier(score: number | null | undefined): SkyTier {
  if (score == null || !Number.isFinite(score)) return "unknown";
  if (score >= 75) return "vivid";
  if (score >= 50) return "warm";
  if (score >= 25) return "mild";
  return "dud";
}

/** Where the sun is in its arc, as far as the scene is concerned. */
export type SunScenePhase = "before" | "golden" | "afterglow" | "night" | "day";

/** Sun still up but the golden window is further off than this → "day" (high,
 *  small sun) rather than "before" (low, large sun about to drop). */
const APPROACH_MINUTES = 120;
/** How long after sunset the afterglow is still worth drawing. */
const AFTERGLOW_MINUTES = 45;

export interface SunScenePhaseArgs {
  /** Instant to place the sun at (ms). Pin this to a snapshot time for SSR. */
  nowMs: number;
  /** The golden window bracketing the NEXT sun event (ms). */
  goldenStartMs: number;
  goldenEndMs: number;
  /** Which event that window belongs to. */
  nextEvent: "sunrise" | "sunset";
  /** Today's sunset (ms), when known — the only way to tell a fresh afterglow
   *  from the middle of the night, since both have a sunrise as the next event. */
  lastSunsetMs?: number | null;
  /** True solar elevation right now, if it's ever wired up. When present it
   *  wins outright: it IS the answer the time math is approximating. */
  sunElevationDeg?: number | null;
}

/**
 * Coarse phase for the scene. Prefers a real solar elevation; otherwise reads
 * the clock against the golden window (which straddles the event: +6°→−4°).
 * Pure — no Date.now() — so the caller controls determinism.
 */
export function sunScenePhase(args: SunScenePhaseArgs): SunScenePhase {
  const { nowMs, goldenStartMs, goldenEndMs, nextEvent, lastSunsetMs, sunElevationDeg } = args;

  if (sunElevationDeg != null && Number.isFinite(sunElevationDeg)) {
    if (sunElevationDeg > 20) return "day";
    if (sunElevationDeg > 6) return "before";
    if (sunElevationDeg > -4) return "golden";
    if (sunElevationDeg > -6) return "afterglow";
    return "night";
  }

  if (
    Number.isFinite(goldenStartMs) &&
    Number.isFinite(goldenEndMs) &&
    nowMs >= goldenStartMs &&
    nowMs <= goldenEndMs
  ) {
    return "golden";
  }

  if (nextEvent === "sunset") {
    // The sun is up: how soon it drops decides how low we draw it.
    const until = goldenStartMs - nowMs;
    return Number.isFinite(until) && until <= APPROACH_MINUTES * 60_000 ? "before" : "day";
  }

  // Next event is a sunrise, so the sun is already down. Only a sunset within
  // the last AFTERGLOW_MINUTES leaves anything in the sky.
  if (lastSunsetMs != null && Number.isFinite(lastSunsetMs)) {
    const since = nowMs - lastSunsetMs;
    if (since >= 0 && since <= AFTERGLOW_MINUTES * 60_000) return "afterglow";
  }
  return "night";
}
