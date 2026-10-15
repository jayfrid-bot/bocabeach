// One loader for every public "small view" of a beach: the Apple Watch route, the
// public v1 API and the MCP tools all call this, so they can never disagree about
// what a beach's score or safety lines are. It builds on lib/watchView.ts, which
// owns the content; this file owns only "fetch, refuse a partial build, strip
// internal fields, and say how long the answer may be cached".

import { getConditions, stripInternalSnapshotFields } from "@/lib/conditions";
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
  if (opts.cacheOnly) {
    const view = await peekWatchView(slug);
    return view ? { status: "ok", view } : { status: "not_cached" };
  }
  const data = await getConditions(slug);
  if (!data) return { status: "not_found" };
  const { budgetAborted, ...publicData } = stripInternalSnapshotFields(data);
  if (budgetAborted) return { status: "incomplete" };
  const view = buildWatchView(publicData as ConditionsResponse);
  await storeWatchView(view); // best effort, never throws
  return { status: "ok", view };
}

/** Whole seconds this view may still be called current (0 or less = expired). */
export function secondsValid(view: Pick<WatchView, "validUntil" | "capturedAt">): number {
  return Math.floor((Date.parse(view.validUntil) - Date.parse(view.capturedAt)) / 1000);
}

/** Cache-Control for one view: min(60 s, time left), or no-store when none is left. */
export function viewCacheControl(view: Pick<WatchView, "validUntil" | "capturedAt">): string {
  return cacheControlFor(secondsValid(view));
}
