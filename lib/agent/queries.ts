// The three read operations, written once. The REST routes and the MCP tools both
// call these, so the two surfaces answer the same way.

import {
  filterBeaches,
  listBeachSummaries,
  nearestBeaches,
  normalizeState,
  type BeachSummary,
  type NearbyBeach,
} from "@/lib/agent/beaches";
import { compactConditions, loadMany, type CompactConditions } from "@/lib/agent/beachView";
import { FAR_AWAY_MILES } from "@/lib/agent/constants";
import { MAX_REGION_LEN, MAX_STATE_LEN, parseText, type Parsed } from "@/lib/agent/params";

export interface ListQuery {
  state?: string;
  region?: string;
}

export function runListBeaches(raw: ListQuery): Parsed<{ count: number; beaches: BeachSummary[] }> {
  let state: string | undefined;
  if (raw.state !== undefined) {
    const t = parseText(raw.state, "state", MAX_STATE_LEN);
    if (!t.ok) return t;
    const s = normalizeState(t.value);
    if (!s) return { ok: false, message: `Unknown state "${t.value}". Use a two-letter code like FL or a full name like Florida.` };
    state = s;
  }
  let region: string | undefined;
  if (raw.region !== undefined) {
    const t = parseText(raw.region, "region", MAX_REGION_LEN);
    if (!t.ok) return t;
    region = t.value;
  }
  const beaches = filterBeaches(listBeachSummaries(), { state, region });
  return { ok: true, value: { count: beaches.length, beaches } };
}

export interface NearbyWithConditions extends NearbyBeach {
  conditions?: CompactConditions | null;
}

export interface NearestResult {
  /** The point asked about, rounded to 2 decimals (about 1 km). Distances use the exact point. */
  query: { lat: number; lon: number; limit: number };
  count: number;
  /** How many of these beaches carry a live score in this answer. */
  scored: number;
  beaches: NearbyWithConditions[];
  note?: string;
}

const round2 = (n: number): number => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r; // never -0
};

/**
 * Nearest beaches, optionally with compact scores for the first `scoreCount`. Scores
 * come from the recent-view store (lib/watchViewCache.ts); at most ONE beach (the nearest one that is
 * not cached) is built for the request (see loadMany). The others say so in `note`.
 */
export async function runNearest(opts: {
  lat: number;
  lon: number;
  limit: number;
  /** How many of the nearest beaches to try to score (0 = none). */
  scoreCount: number;
}): Promise<NearestResult> {
  const near = nearestBeaches(opts.lat, opts.lon, opts.limit);
  const toScore = near.slice(0, Math.max(0, opts.scoreCount));
  const outcomes = toScore.length ? await loadMany(toScore.map((b) => b.slug)) : [];
  const bySlug = new Map(outcomes.map((o) => [o.slug, o]));
  let scored = 0;
  const notNow: string[] = [];
  const failed: string[] = [];
  const beaches = near.map((b): NearbyWithConditions => {
    const o = bySlug.get(b.slug);
    if (!o) return b;
    if (!o.ok) {
      (o.reason === "not_cached" || o.reason === "expired" ? notNow : failed).push(b.slug);
      return { ...b, conditions: null };
    }
    scored += 1;
    return { ...b, conditions: compactConditions(o.conditions) };
  });
  const notes: string[] = [];
  if (beaches.length && beaches[0].distanceMiles > FAR_AWAY_MILES) {
    notes.push(`The nearest covered beach is ${beaches[0].distanceMiles} miles away. Nothing is close to this point.`);
  }
  if (notNow.length) {
    notes.push(`Not scored right now (no current snapshot; at most one is built per request): ${notNow.join(", ")}. Ask for one beach by slug to get its score.`);
  }
  if (failed.length) notes.push(`Scores could not be built right now for: ${failed.join(", ")}. Try again shortly.`);
  return {
    query: { lat: round2(opts.lat), lon: round2(opts.lon), limit: opts.limit },
    count: beaches.length,
    scored,
    beaches,
    ...(notes.length ? { note: notes.join(" ") } : {}),
  };
}
