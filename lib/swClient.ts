// Page-side rules for the service worker (public/sw.js). Pure functions, so the
// registrar component and the dashboard hook stay thin and these stay testable.
// The worker's own rules are tested in lib/swRules.test.ts; docs/SERVICE_WORKER.md
// explains the whole design.

import type { ConditionsResponse } from "@/lib/types";
import { fromWire, type WireConditions } from "@/lib/clientConditions";

/** The native shells append this to the user agent (capacitor.config.ts). */
export const NATIVE_SHELL_UA_MARK = "IsItBeachDayApp/";

/** A saved copy older than this gets the "Showing saved conditions" note. */
export const SAVED_NOTE_AFTER_MS = 30 * 60 * 1000;

/** If fresh data has not arrived by now, the note says it could not update. */
export const SAVED_NOTE_GIVE_UP_MS = 20 * 1000;

/** The page reloads itself for a new build only inside this window and only if untouched. */
export const BUILD_RELOAD_WINDOW_MS = 30 * 1000;
export const BUILD_RELOAD_GAP_MS = 2 * 60 * 1000;

export type SwDecision = "register" | "remove";

/**
 * Should this page run the service worker?
 *  - Not in a production build (local dev): no, and remove any leftover.
 *  - Not inside the native app shells: no. iOS needs App-Bound Domains for a worker at all
 *    (docs/SERVICE_WORKER.md), and Android stays on the live site until the owner decides.
 *  - Not when the reader opted out with ?nosw=1 (sticky; ?sw=on undoes it).
 */
export function swDecision(i: { production: boolean; userAgent: string; optedOut: boolean }): SwDecision {
  if (!i.production) return "remove";
  if (i.userAgent.includes(NATIVE_SHELL_UA_MARK)) return "remove";
  if (i.optedOut) return "remove";
  return "register";
}

/** Read the sticky opt-out. `search` is location.search; `stored` is localStorage "ibd:sw". */
export function optOutState(search: string, stored: string | null): { optedOut: boolean; store: "off" | "clear" | null } {
  const q = new URLSearchParams(search);
  if (q.get("sw") === "on") return { optedOut: false, store: "clear" };
  if (q.has("nosw")) return { optedOut: true, store: "off" };
  return { optedOut: stored === "off", store: null };
}

/**
 * The worker stamps each stored page with `Server-Timing: ibd-sw;desc="<ms>"`.
 * Returns that time (when the copy was saved), or null for a page that came from the network.
 */
export function savedAtFromServerTiming(entries: ReadonlyArray<{ name: string; description?: string }>): number | null {
  for (const e of entries) {
    if (e.name !== "ibd-sw") continue;
    const n = Number(e.description);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Show the saved-copy note only when the copy is old enough to matter. */
export function showSavedNote(savedAt: number | null, now: number): boolean {
  return savedAt != null && now - savedAt > SAVED_NOTE_AFTER_MS;
}

/** "2:41 PM", or "Sat 2:41 PM" when the copy is from another day. */
export function formatSavedAt(savedAt: number, now: number, locale?: string): string {
  const d = new Date(savedAt);
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return d.toLocaleString(locale, {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export interface FreshMessage {
  type?: unknown;
  kind?: unknown;
  slug?: unknown;
  data?: unknown;
}

/**
 * Does a worker "fresh data" message carry a snapshot this dashboard should show?
 * Only for this beach, only with a real snapshot, never older than what is on screen.
 */
export function shouldApplyFresh<T extends { snapshot?: { generatedAt?: string } }>(
  msg: FreshMessage | null | undefined,
  slug: string,
  shownGeneratedAt: string,
): T | null {
  if (!msg || msg.type !== "ibd-fresh" || msg.kind !== "conditions" || msg.slug !== slug) return null;
  const data = msg.data as T | undefined;
  const at = data?.snapshot?.generatedAt;
  if (!at) return null;
  const incoming = Date.parse(at);
  if (!Number.isFinite(incoming)) return null;
  const shown = Date.parse(shownGeneratedAt);
  if (Number.isFinite(shown) && incoming < shown) return null;
  return data as T;
}

/**
 * Sent by the dashboard on its first data call of a page load only. The worker answers that
 * one call from its saved copy and refreshes behind it; every call without it (poll, resume,
 * Refresh button) goes to the network. Same name in public/sw.js (a test checks).
 */
export const FIRST_CALL_HEADER = "x-ibd-first-call";

/** The dashboard's data call, which the worker answers and refreshes (public/sw.js). */
export function leanDataPath(slug: string): string {
  return `/api/conditions/${slug}/lean`;
}

/**
 * The fresh snapshot in a worker message, unpacked for the dashboard. The worker caches
 * and posts the lean route's packed form as it came (lib/clientConditions.ts), so it is
 * unpacked here; the same newer-or-equal rule as shouldApplyFresh applies.
 */
export function freshConditionsFromMessage(
  msg: FreshMessage | null | undefined,
  slug: string,
  shownGeneratedAt: string,
): ConditionsResponse | null {
  const data = shouldApplyFresh<WireConditions | ConditionsResponse>(msg, slug, shownGeneratedAt);
  if (!data) return null;
  try {
    return fromWire(data);
  } catch {
    return null; // a malformed packed body is ignored; the poll still runs
  }
}

/**
 * The worker saw a new build behind the page on screen. Reload at once only if nothing
 * can be lost: the reader has not touched the page, no dialog is open, no purchase is
 * in flight, and we did not already reload a moment ago. Otherwise leave it: the next
 * open (or the resume check in lib/useReloadOnNewVersion.ts) picks the new build up.
 */
export function shouldReloadForNewBuild(i: {
  now: number;
  openedAt: number;
  interacted: boolean;
  dialogOpen: boolean;
  held: boolean;
  lastReloadAt: number | null;
}): boolean {
  if (i.interacted || i.dialogOpen || i.held) return false;
  if (i.now - i.openedAt > BUILD_RELOAD_WINDOW_MS) return false;
  if (i.lastReloadAt != null && i.now - i.lastReloadAt < BUILD_RELOAD_GAP_MS) return false;
  return true;
}
