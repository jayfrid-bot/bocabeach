// One loader for every public "small view" of a beach: the Apple Watch route, the
// public v1 API and the MCP tools all call this, so they can never disagree about
// what a beach's score or safety lines are. It builds on lib/watchView.ts, which
// owns the content; this file owns only "fetch, refuse a partial build, strip
// internal fields, and say how long the answer may be cached".

import { getCachedConditions, getConditions, stripInternalSnapshotFields } from "@/lib/conditions";
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
 * `cacheOnly` reads the shared conditions cache and never starts a build. A miss, or a
 * cached view that is already past its `validUntil`, is "not_cached".
 */
export async function loadWatchView(slug: string): Promise<Exclude<WatchLoad, { status: "not_cached" }>>;
export async function loadWatchView(slug: string, opts: { cacheOnly: true }): Promise<WatchLoad>;
export async function loadWatchView(slug: string, opts: { cacheOnly?: boolean } = {}): Promise<WatchLoad> {
  if (!isValidSlug(slug)) return { status: "not_found" };
  const data = opts.cacheOnly ? await getCachedConditions(slug) : await getConditions(slug);
  if (!data) return opts.cacheOnly ? { status: "not_cached" } : { status: "not_found" };
  const { budgetAborted, ...publicData } = stripInternalSnapshotFields(data);
  if (budgetAborted) return { status: "incomplete" };
  const view = buildWatchView(publicData as ConditionsResponse);
  if (opts.cacheOnly && Date.parse(view.validUntil) <= Date.now()) return { status: "not_cached" };
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
