// Beach Mode's arming rules: how long a window lasts, whether an explicit Off
// sticks, and whether an armed request may use the phone's own coordinates.
// Pure — no React, no storage, no fetch — so the tricky arithmetic and the
// "does Off really stick" question are tested directly rather than through a
// rendered card. lib/plus/client.ts and components/plus/BeachModeCard.tsx are
// thin wrappers over these.

import { MAX_ARM_MS } from "@/lib/db/plus";
import { isWithinMi } from "@/lib/location/nearest";
import { haversineMiles } from "@/lib/util";
import type { OffSuppression } from "@/lib/plus/types";

// Re-export rather than duplicate: the client's optimistic cap must always
// match the server's real one (lib/db/plus.ts), or Extend can promise more
// than `/api/presence` will actually grant.
export { MAX_ARM_MS };

/** Inside this, the phone counts as "at" a beach — for auto-arm, for honoring
 *  an Off suppression, and for deciding whether a manual arm may use the
 *  phone's own fix. One radius, used everywhere "near" means the same thing. */
export const AT_BEACH_MI = 2;

/** How long a self-triggered (auto) window lasts, and how far Extend reaches. */
export const AUTO_ARM_MS = 4 * 3600 * 1000;
/** How long tapping the card by hand, away from the beach, arms for. */
export const MANUAL_ARM_MS = 6 * 3600 * 1000;

/** Never re-arm more than once a minute, however often the app foregrounds. */
export const ARM_THROTTLE_MS = 60_000;
/** …and only top a live window up once it is down to its last hour. */
export const ARM_TOP_UP_MS = 3600 * 1000;

/** A suppression this old is honored no further, even if the phone never
 *  left — a safety valve for a user who simply lives within the radius. */
export const SUPPRESSION_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * Should the auto-arm effect fire now? Pure, because getting it wrong is
 * expensive: the effect re-runs on every render (the app re-renders once a
 * minute to keep its clock moving), so a bare throttle wrote a fresh presence
 * row every 60 seconds for as long as someone stood on the sand. A window
 * with hours left on it needs nothing.
 */
export function shouldAutoArm(now: number, lastArmAt: number, armedUntil: number): boolean {
  if (now - lastArmAt < ARM_THROTTLE_MS) return false;
  return armedUntil - now <= ARM_TOP_UP_MS;
}

/**
 * The next armedUntil for an arm/Extend request. Never earlier than what is
 * already armed — a manual six-hour window followed immediately by an Extend
 * (which asks for four) must not roll the clock backward two hours — and
 * never later than the server's own cap, so the optimistic UI can't promise
 * more than `/api/presence` will actually grant.
 */
export function extendArmedUntil(currentArmedUntil: number, now: number, durationMs: number): number {
  const proposed = Math.max(currentArmedUntil, now + durationMs);
  return Math.min(proposed, now + MAX_ARM_MS);
}

/**
 * Should a stored Off suppression be dropped? Yes once it is a day old
 * (regardless of where the phone is), or once a fix shows the phone is no
 * longer within nearness of the spot it was turned off at. `fix === null`
 * means no fresher information has arrived, so age is the only thing that can
 * clear it.
 */
export function shouldClearSuppression(
  suppression: OffSuppression,
  now: number,
  fix: { lat: number; lon: number } | null,
): boolean {
  if (now - suppression.since >= SUPPRESSION_MAX_AGE_MS) return true;
  if (!fix) return false;
  const distanceMi = haversineMiles(fix.lat, fix.lon, suppression.lat, suppression.lon);
  return !isWithinMi(distanceMi, AT_BEACH_MI);
}

/**
 * Should auto-arm skip `slug` right now because the user just turned it off?
 * Only while the suppression names this exact beach and has not gone stale —
 * `shouldClearSuppression` is the single source of truth for staleness so the
 * two questions ("is it stale" and "should it be honored") can never disagree.
 */
export function isSuppressed(
  suppression: OffSuppression | null,
  slug: string,
  now: number,
  fix: { lat: number; lon: number } | null,
): boolean {
  if (!suppression || suppression.slug !== slug) return false;
  return !shouldClearSuppression(suppression, now, fix);
}

/** A fix, or anything shaped closely enough to arm with. */
export interface ArmFix {
  lat: number;
  lon: number;
  accuracyM: number;
  at: number;
}

/** What a presence request should carry for its location fields. */
export interface ArmCoords {
  lat: number | null;
  lon: number | null;
  accuracyM: number | null;
  fixAt: number | null;
}

/**
 * What coordinates an arm request should send. Auto-arm always uses the
 * phone's own fix — it only ever fires once the phone is already near that
 * beach. A MANUAL arm of a beach the phone is not actually near sends no
 * coordinates at all: mislabeling a distant fix as "at" that beach would make
 * lightning/rain distance measure the wrong spot, so the server falls back to
 * the beach's own centroid instead. No fix at all is the same case as "not
 * near" — nothing trustworthy to send.
 */
export function resolveArmCoords(
  source: "auto" | "manual",
  fix: ArmFix | null,
  centroid: { lat: number; lon: number } | null,
): ArmCoords {
  if (!fix) return { lat: null, lon: null, accuracyM: null, fixAt: null };
  if (source === "auto") {
    return { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, fixAt: fix.at };
  }
  const distanceMi = centroid ? haversineMiles(fix.lat, fix.lon, centroid.lat, centroid.lon) : Infinity;
  if (!isWithinMi(distanceMi, AT_BEACH_MI)) return { lat: null, lon: null, accuracyM: null, fixAt: null };
  return { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, fixAt: fix.at };
}

/** Which of BeachModeCard's four bodies should render. Centralized so the
 *  "device metadata not loaded yet" gate (issue #11) can be tested without
 *  rendering the card: the door outranks everything (a cached "not entitled"
 *  renders on the very first frame), then the loading state, then armed vs.
 *  idle. */
export type BeachModeView = "door" | "loading" | "armed" | "idle";

export function resolveBeachModeView(input: {
  entitled: boolean;
  locked: boolean;
  deviceLoaded: boolean;
  armed: boolean;
}): BeachModeView {
  if (!input.entitled || input.locked) return "door";
  if (!input.deviceLoaded) return "loading";
  return input.armed ? "armed" : "idle";
}
