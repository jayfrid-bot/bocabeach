// Beach Mode's arming rules: how long a window lasts, whether an explicit Off
// sticks, and whether an armed request may use the phone's own coordinates.
// Pure — no React, no storage, no fetch — so the tricky arithmetic and the
// "does Off really stick" question are tested directly rather than through a
// rendered card. lib/plus/client.ts and components/plus/BeachModeCard.tsx are
// thin wrappers over these.

import { MAX_ARM_MS } from "@/lib/db/plus";
import { isWithinMi, nearestServedBeach } from "@/lib/location/nearest";
import {
  ARRIVAL_MAX_FIX_AGE_MS,
  FIX_MAX_ACCURACY_M,
  FIX_MAX_FUTURE_SKEW_MS,
} from "@/lib/location/device";
import { haversineMiles } from "@/lib/util";
import type { OffSuppression } from "@/lib/plus/types";
import type { LocationPublic } from "@/lib/types";

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

/** How often an ARMED session re-uploads the phone's position on foreground
 *  (LOC-02). Independent of the expiry top-up: a fresh position is worth
 *  sending long before the window is down to its last hour. */
export const PRESENCE_REFRESH_MS = 5 * 60 * 1000;

/** Round a position to two decimals (~0.7 mi) — all an Off suppression needs
 *  to know to answer "still standing here?", and far less than a raw fix. */
export function coarsePosition(lat: number, lon: number): { lat: number; lon: number } {
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

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
 * Keyed on the (beach, position) pair: honored while the suppression names
 * this beach OR the phone is still within nearness of the spot Off was tapped
 * at — so an Off while armed for A but standing nearer B does not re-arm B a
 * second later. "Off sticks until you leave the beach", whichever beach the
 * nearest-math names. `shouldClearSuppression` is the single source of truth
 * for staleness so the two questions can never disagree.
 */
export function isSuppressed(
  suppression: OffSuppression | null,
  slug: string,
  now: number,
  fix: { lat: number; lon: number } | null,
): boolean {
  if (!suppression) return false;
  if (shouldClearSuppression(suppression, now, fix)) return false;
  if (suppression.slug === slug) return true;
  if (!fix) return false;
  return isWithinMi(haversineMiles(fix.lat, fix.lon, suppression.lat, suppression.lon), AT_BEACH_MI);
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

const NO_COORDS: ArmCoords = { lat: null, lon: null, accuracyM: null, fixAt: null };

/**
 * Is this fix good enough to say the phone is AT `centroid` right now
 * (LOC-12, LOC-06)? Near enough, precise enough, and recent enough — all
 * three. A 50 km-accurate point "near" a beach, or a precise point from
 * twenty minutes ago, is a nearby list, not an arrival.
 */
export function establishesArrival(
  fix: ArmFix | null,
  centroid: { lat: number; lon: number } | null,
  now: number,
): boolean {
  if (!fix || !centroid) return false;
  if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > FIX_MAX_ACCURACY_M) return false;
  if (!Number.isFinite(fix.at)) return false;
  if (now - fix.at > ARRIVAL_MAX_FIX_AGE_MS) return false;
  if (fix.at - now > FIX_MAX_FUTURE_SKEW_MS) return false;
  return isWithinMi(haversineMiles(fix.lat, fix.lon, centroid.lat, centroid.lon), AT_BEACH_MI);
}

/**
 * What coordinates an arm request should send. The SAME proximity gate for
 * auto and manual (LOC-04): a fix that is not near the target beach — or is
 * too imprecise to place the phone there — sends no coordinates at all.
 * Mislabeling a distant or fuzzy fix as "at" that beach would make
 * lightning/rain distance measure the wrong spot, so the server falls back
 * to the beach's own centroid instead. Home coordinates never get forwarded.
 * No fix at all is the same case — nothing trustworthy to send.
 */
export function resolveArmCoords(
  _source: "auto" | "manual",
  fix: ArmFix | null,
  centroid: { lat: number; lon: number } | null,
): ArmCoords {
  if (!fix || !centroid) return NO_COORDS;
  if (!Number.isFinite(fix.accuracyM) || fix.accuracyM > FIX_MAX_ACCURACY_M) return NO_COORDS;
  const distanceMi = haversineMiles(fix.lat, fix.lon, centroid.lat, centroid.lon);
  if (!isWithinMi(distanceMi, AT_BEACH_MI)) return NO_COORDS;
  return { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, fixAt: fix.at };
}

/** The three things a presence write can be for (LOC-02). */
export type ArmMode =
  /** The phone walked up: monitor the nearest beach, from the fresh fix. */
  | "auto"
  /** A deliberate tap on THIS page's beach — sticky, wherever the phone is. */
  | "manual"
  /** Extend / refresh an existing session: same beach, never retargets (LOC-05). */
  | "extend";

export interface ArmDecisionInput {
  mode: ArmMode;
  /** The fix obtained for THIS request, after the await — never the one from
   *  before it (LOC-04). Null when the request failed. */
  freshFix: ArmFix | null;
  beaches: LocationPublic[];
  /** The beach the page is showing. */
  pageSlug: string;
  /** The session already armed, when there is one. */
  presence: { slug: string; source: "auto" | "manual" } | null;
  now: number;
}

export type ArmDecision =
  | { ok: true; slug: string; source: "auto" | "manual"; coords: ArmCoords; fromSpot: boolean }
  | { ok: false; reason: "no-arrival" | "no-session" };

/**
 * One validated decision per arm request (LOC-04, LOC-05, LOC-12): pick the
 * target from the fix this request actually got, gate it, and only then
 * decide what to send.
 *
 *  - auto:   nearest beach to the FRESH fix; cancelled unless that fix
 *            establishes arrival there. Never falls back to an older fix.
 *  - manual: the page's beach; coordinates only if the fresh fix is at it.
 *  - extend: the session's own beach, explicitly — browsing B while A is
 *            armed and tapping Extend keeps A. Coordinates as for manual.
 */
export function decideArm(input: ArmDecisionInput): ArmDecision {
  const { mode, freshFix, beaches, now } = input;
  const centroidOf = (slug: string) => beaches.find((b) => b.slug === slug) ?? null;

  if (mode === "auto") {
    const nearest = freshFix ? nearestServedBeach(freshFix.lat, freshFix.lon, beaches) : null;
    if (!nearest || !establishesArrival(freshFix, nearest.beach, now)) return { ok: false, reason: "no-arrival" };
    return {
      ok: true,
      slug: nearest.beach.slug,
      source: "auto",
      coords: resolveArmCoords("auto", freshFix, nearest.beach),
      fromSpot: true,
    };
  }

  if (mode === "extend") {
    if (!input.presence) return { ok: false, reason: "no-session" };
    const centroid = centroidOf(input.presence.slug);
    const coords = resolveArmCoords("manual", freshFix, centroid);
    return { ok: true, slug: input.presence.slug, source: input.presence.source, coords, fromSpot: coords.lat != null };
  }

  const centroid = centroidOf(input.pageSlug);
  const coords = resolveArmCoords("manual", freshFix, centroid);
  return { ok: true, slug: input.pageSlug, source: "manual", coords, fromSpot: coords.lat != null };
}

/**
 * Should an armed session move to `nearestSlug`? Only an AUTO session follows
 * the phone: a beach someone chose by hand is sticky (LOC-02's destination
 * policy). `arrived` is `establishesArrival` for the nearest beach.
 */
export function shouldRetarget(
  presence: { slug: string; source: "auto" | "manual" } | null,
  nearestSlug: string | null,
  arrived: boolean,
): boolean {
  if (!presence || !nearestSlug || !arrived) return false;
  return presence.source === "auto" && presence.slug !== nearestSlug;
}

/**
 * Should an armed session re-upload the phone's position now (LOC-02)?
 * Bounded by PRESENCE_REFRESH_MS, and only for a fix newer than the one last
 * sent — a stationary reopen with nothing new to say sends nothing.
 */
export function shouldRefreshPresence(
  now: number,
  lastUploadAt: number,
  fixAt: number | null,
  lastUploadedFixAt: number | null,
): boolean {
  if (fixAt == null) return false;
  if (now - lastUploadAt < PRESENCE_REFRESH_MS) return false;
  return lastUploadedFixAt == null || fixAt > lastUploadedFixAt;
}

/**
 * May the auto-arm effect write yet (R-01)? Both the device row (entitlement,
 * any existing session) and the saved Off suppression must have been read
 * first — `suppressionLoaded` starts false and flips true only once the
 * stored suppression comes back from storage. Without this gate, a cached
 * entitlement plus a leftover session fix could auto-arm on the very first
 * render, before the card even knows about an Off from earlier in the day.
 */
export function canAutoArm(input: { deviceLoaded: boolean; suppressionLoaded: boolean }): boolean {
  return input.deviceLoaded && input.suppressionLoaded;
}

/**
 * Is `ticket` still the current arm request (R-02)? `arm()` takes a ticket
 * from `armSeqRef` before each await; a mismatch after the await means a
 * newer request — another tap, a retarget, or `disarm()` bumping the ref —
 * took over while this one was in flight, and its result must be dropped
 * rather than overwrite the newer intent.
 */
export function isCurrentArmTicket(ticket: number, current: number): boolean {
  return ticket === current;
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

/** Can an alert actually reach this phone? Monitoring and delivery are two
 *  facts, and the card must never let one stand in for the other (LOC-03). */
export type DeliveryState = "ready" | "needs-setup" | "denied" | "unknown";

/**
 * Fold the two readiness signals into one honest label. The server's answer
 * (`pushReady` from /api/presence — a token is stored for this device) wins
 * when it exists; the phone's own permission check is the fallback, and a
 * local "denied" always shows, since a stored token cannot be delivered to a
 * phone that has since blocked notifications.
 */
export function resolveDelivery(
  serverPushReady: boolean | null,
  local: "on" | "off" | "denied" | null,
): DeliveryState {
  if (local === "denied") return "denied";
  if (serverPushReady === true) return "ready";
  if (serverPushReady === false) return "needs-setup";
  if (local === "on") return "ready";
  if (local === "off") return "needs-setup";
  return "unknown";
}
