// A beach's live answer for agents: the Apple Watch view (lib/watchView.ts, built
// by lib/watchLoad.ts) plus the beach's page link, a one-line summary, attribution
// and the safety note. No Plus data, no device data, no webcam images.

import { findBeach } from "@/lib/agent/beaches";
import { ATTRIBUTION, DISCLAIMER, SAFETY_NOTE } from "@/lib/agent/constants";
import { loadWatchView } from "@/lib/watchLoad";
import type { WatchLine, WatchView } from "@/lib/watchView";

export interface BeachConditions {
  /** Bump only when a field changes meaning. */
  v: 1;
  slug: string;
  name: string;
  region: string;
  state: string | null;
  url: string;
  lat: number;
  lon: number;
  /** 0-100, or null when there was not enough live data. */
  score: number | null;
  /** "Excellent" | "Good" | "Decent" | "Marginal" | "Poor"; null with no score. */
  rating: string | null;
  /** Lowercase rating word. */
  band: string | null;
  /** The score was built from too little live data. */
  limitedData: boolean;
  /** One plain sentence: score, then every safety and water line, then the best time. */
  summary: string;
  /** Same lines and tones the website and the watch show, worst safety first. */
  lines: WatchLine[];
  waterTempF: number | null;
  /** Best window today, e.g. "4–6 PM", or null (see lines for "No good window today"). */
  bestTime: string | null;
  /** When the server built the conditions snapshot. */
  generatedAt: string | null;
  /** Same moment as generatedAt, or when this view was computed if that is unknown. */
  updatedAt: string;
  /** When this view was computed. */
  capturedAt: string;
  /** After this moment, do not call the answer current. */
  validUntil: string;
  safetyNote: string;
  disclaimer: string;
  attribution: typeof ATTRIBUTION;
}

export type BeachLoad =
  | { status: "ok"; conditions: BeachConditions }
  | { status: "not_found" }
  | { status: "incomplete" }
  | { status: "not_cached" };

/** "Boca Raton: 78/100 (Good). Yellow flag. Water 82°F. Best 4–6 PM." */
export function summarize(view: Pick<WatchView, "name" | "score" | "rating" | "lines">): string {
  const head =
    view.score == null
      ? `${view.name}: no usable score right now`
      : `${view.name}: ${view.score}/100 (${view.rating})`;
  const parts = view.lines.map((l) => {
    const text = l.text.replace(/[.\s]+$/, "");
    const more = l.kind === "more" ? /^\+(\d+) more$/.exec(text) : null;
    return more ? `${more[1]} more safety notices are not listed here; see the beach page` : text;
  });
  return `${[head, ...parts].join(". ")}.`;
}

export function toBeachConditions(view: WatchView): BeachConditions | null {
  const beach = findBeach(view.slug);
  if (!beach) return null;
  const best = view.lines.find((l) => l.kind === "best");
  const bestTime = best && best.text.startsWith("Best ") ? best.text.slice(5) : null;
  return {
    v: 1,
    slug: view.slug,
    name: view.name,
    region: beach.region,
    state: beach.state,
    url: beach.url,
    lat: beach.lat,
    lon: beach.lon,
    score: view.score,
    rating: view.rating,
    band: view.band,
    limitedData: view.limitedData,
    summary: summarize(view),
    lines: view.lines,
    waterTempF: view.waterTempF,
    bestTime,
    generatedAt: view.generatedAt,
    updatedAt: view.generatedAt ?? view.capturedAt,
    capturedAt: view.capturedAt,
    validUntil: view.validUntil,
    safetyNote: SAFETY_NOTE,
    disclaimer: DISCLAIMER,
    attribution: ATTRIBUTION,
  };
}

/** `cacheOnly`: read the shared conditions cache and never start a build. */
export async function loadBeachConditions(slug: string): Promise<Exclude<BeachLoad, { status: "not_cached" }>>;
export async function loadBeachConditions(slug: string, opts: { cacheOnly: true }): Promise<BeachLoad>;
export async function loadBeachConditions(slug: string, opts: { cacheOnly?: boolean } = {}): Promise<BeachLoad> {
  const loaded = opts.cacheOnly ? await loadWatchView(slug, { cacheOnly: true }) : await loadWatchView(slug);
  if (loaded.status !== "ok") return loaded;
  const conditions = toBeachConditions(loaded.view);
  return conditions ? { status: "ok", conditions } : { status: "not_found" };
}

/** The small form used when several beaches are listed together. */
export interface CompactConditions {
  score: number | null;
  rating: string | null;
  limitedData: boolean;
  summary: string;
  /** True when any line is at the danger tone (flag, warning, lightning, rip). */
  hasDangerAlert: boolean;
  updatedAt: string;
  validUntil: string;
}

export function compactConditions(c: BeachConditions): CompactConditions {
  return {
    score: c.score,
    rating: c.rating,
    limitedData: c.limitedData,
    summary: c.summary,
    hasDangerAlert: c.lines.some((l) => l.tone === "danger"),
    updatedAt: c.updatedAt,
    validUntil: c.validUntil,
  };
}

export type ScoreOutcome =
  | { slug: string; ok: true; conditions: BeachConditions }
  | { slug: string; ok: false; reason: "not_found" | "incomplete" | "not_cached" | "error" };

/**
 * Score several beaches in one request WITHOUT fanning out into cold builds. A cold
 * build is a full source fetch (about 25 subrequests); Workers Free allows 50 per
 * request. So: every beach is first read from the shared cache (no build); then at
 * most ONE beach that was not cached, the first in `slugs` order, is built. Every
 * other uncached beach comes back as reason "not_cached" and is never built.
 */
export async function loadMany(slugs: readonly string[]): Promise<ScoreOutcome[]> {
  const toOutcome = (slug: string, r: PromiseSettledResult<BeachLoad>): ScoreOutcome => {
    if (r.status === "rejected") return { slug, ok: false, reason: "error" };
    if (r.value.status === "ok") return { slug, ok: true, conditions: r.value.conditions };
    return { slug, ok: false, reason: r.value.status };
  };
  const peeked = await Promise.allSettled(slugs.map((s) => loadBeachConditions(s, { cacheOnly: true })));
  const out = slugs.map((slug, i) => toOutcome(slug, peeked[i]));
  const firstMiss = out.findIndex((o) => !o.ok && o.reason === "not_cached");
  if (firstMiss >= 0) {
    const slug = slugs[firstMiss];
    const [built] = await Promise.allSettled([loadBeachConditions(slug)]);
    out[firstMiss] = toOutcome(slug, built);
  }
  return out;
}
