// One loader for every public "small view" of a beach: the Apple Watch route, the
// public v1 API and the MCP tools all call this, so they can never disagree about
// what a beach's score or safety lines are. It builds on lib/watchView.ts, which
// owns the content; this file owns only "fetch, refuse a partial build, strip
// internal fields, and say how long the answer may be cached".

import { conditionsOverrides, getConditions, stripInternalSnapshotFields } from "@/lib/conditions";
import { peekWatchView, storeWatchView } from "@/lib/watchViewCache";
import { buildWatchView, cacheControlFor, type WatchView } from "@/lib/watchView";
import type { ConditionsResponse } from "@/lib/types";

/** Lowercase words joined by single dashes, at most 64 characters. */
export function isValidSlug(slug: string): boolean {
  return slug.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug);
}

export type WatchLoad =
  | { status: "ok"; view: WatchView }
  | { status: "not_found" }
  /** The build ran out of upstream budget. Deliberately incomplete: never an answer. */
  | { status: "incomplete" }
  /** Cache-only lookups only: no recent snapshot was in the shared cache, and none was built. */
  | { status: "not_cached" };

/**
 * `cacheOnly` reads the recent-view store (lib/watchViewCache.ts) and never starts a
 * build or writes anything: a hit is a view that is still inside its validUntil, a miss
 * is "not_cached". A normal call builds, and remembers every successful view there.
 */
export async function loadWatchView(slug: string): Promise<Exclude<WatchLoad, { status: "not_cached" }>>;
export async function loadWatchView(slug: string, opts: { cacheOnly: true }): Promise<WatchLoad>;
export async function loadWatchView(slug: string, opts: { cacheOnly?: boolean } = {}): Promise<WatchLoad> {
  if (!isValidSlug(slug)) return { status: "not_found" };
  // The owner-override fingerprint is part of a stored view's identity: a correction by the
  // owner changes it, and every view stored before the correction stops matching.
  // Read ONCE and used for everything below: the conditions-cache key, the build, and the
  // recent-view store. If the lookup failed ("0" means unknown, not "no verdicts"), nothing is
  // read from or written to the recent-view store, so a pre-correction answer can never sit
  // under a fingerprint that later looks current.
  const fingerprint = await conditionsOverrides(slug);
  const { version: ov, reliable } = fingerprint;
  if (opts.cacheOnly) {
    const view = reliable ? await peekWatchView(slug, ov) : null;
    return view ? { status: "ok", view } : { status: "not_cached" };
  }
  const loaded = await loadPublicConditions(slug, fingerprint);
  if (loaded.status !== "ok") return loaded;
  const view = buildWatchView(loaded.conditions);
  if (reliable) await storeWatchView(view, ov); // best effort, never throws
  return { status: "ok", view };
}

export type PublicConditionsLoad =
  | { status: "ok"; conditions: ConditionsResponse }
  | { status: "not_found" }
  | { status: "incomplete" };

/**
 * The full public conditions response for one beach (the shared 120-s conditions cache, or one
 * build), with the internal fields stripped. A partial build is "incomplete". For views that
 * need more than the compact watch view, such as the multi-day outlook. One call is at most
 * ONE build.
 */
export async function loadPublicConditions(
  slug: string,
  fingerprint?: { version: string; reliable: boolean },
): Promise<PublicConditionsLoad> {
  if (!isValidSlug(slug)) return { status: "not_found" };
  const fp = fingerprint ?? (await conditionsOverrides(slug));
  const data = await getConditions(slug, { fingerprint: fp });
  if (!data) return { status: "not_found" };
  const { budgetAborted, ...publicData } = stripInternalSnapshotFields(data);
  if (budgetAborted) return { status: "incomplete" };
  return { status: "ok", conditions: publicData as ConditionsResponse };
}

/** Whole seconds this view may still be called current at `nowMs` (0 or less = expired). */
export function secondsValid(view: Pick<WatchView, "validUntil">, nowMs: number = Date.now()): number {
  return Math.floor((Date.parse(view.validUntil) - nowMs) / 1000);
}

/**
 * Cache-Control for one view, computed from the clock at the moment the response is made
 * (after every await, including the recent-view write): min(60 s, time left), or no-store
 * at zero or less. A downstream cache can therefore never keep it past validUntil.
 */
export function viewCacheControl(view: Pick<WatchView, "validUntil">, nowMs: number = Date.now()): string {
  return cacheControlFor(secondsValid(view, nowMs));
}
