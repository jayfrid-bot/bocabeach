// The five MCP tools. Each has a JSON Schema (sent in tools/list and used to check
// the arguments) and a run() that calls the same shared code the REST routes use.
// Every output carries the attribution and the safety note, as text and as
// structuredContent.

import { nearestBeaches, type BeachSummary, type NearbyBeach } from "@/lib/agent/beaches";
import {
  compactConditions,
  loadBeachConditions,
  loadMany,
  type BeachConditions,
  type CompactConditions,
} from "@/lib/agent/beachView";
import {
  ATTRIBUTION,
  CREDIT,
  DEFAULT_COMPARE,
  DEFAULT_OUTLOOK_DAYS,
  DEFAULT_RADIUS_MILES,
  DISCLAIMER,
  MAX_COMPARE,
  MAX_MCP_NEAREST,
  MAX_OUTLOOK_DAYS,
  MAX_RADIUS_MILES,
  MAX_REST_SCORES,
  SAFETY_NOTE,
} from "@/lib/agent/constants";
import { loadBeachOutlook } from "@/lib/agent/outlook";
import { runListBeaches, runNearest } from "@/lib/agent/queries";
import { isValidSlug } from "@/lib/watchLoad";
import type { JsonSchema } from "@/lib/agent/schema";

export interface ToolOutput {
  /** Plain text for the model to read. */
  text: string;
  /** The same facts as data. */
  data?: Record<string, unknown>;
  /** True for a tool that ran but could not give an answer (unknown beach, bad input). */
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  run(args: Record<string, unknown>): Promise<ToolOutput>;
}

const FOOTER = `${SAFETY_NOTE} ${DISCLAIMER} ${CREDIT}`;
const common = { safetyNote: SAFETY_NOTE, disclaimer: DISCLAIMER, attribution: ATTRIBUTION };

const fail = (text: string): ToolOutput => ({ text: `${text}\n${SAFETY_NOTE}`, isError: true });

const dist = (b: { distanceMiles?: number; direction?: string }) =>
  b.distanceMiles == null ? "" : ` (${[`${b.distanceMiles} mi`, b.direction].filter(Boolean).join(" ")})`;

// ---- list_beaches ------------------------------------------------------------

const listBeaches: ToolDef = {
  name: "list_beaches",
  title: "List beaches",
  description:
    "List the US beaches Is It Beach Day covers (Atlantic, Gulf and Pacific coasts), with slug, name, state, coordinates and page URL. Use the slug with get_beach_score. Optionally filter by US state (code or name) or by text in the beach name or county. Does not fetch live conditions.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", maxLength: 40, description: 'US state, as a two-letter code or full name, e.g. "FL" or "Florida".' },
      region: { type: "string", maxLength: 80, description: 'Text found in the beach name or county, e.g. "Broward" or "Miami".' },
    },
    additionalProperties: false,
  },
  async run(args) {
    const r = runListBeaches({ state: args.state as string | undefined, region: args.region as string | undefined });
    if (!r.ok) return fail(r.message);
    const { count, beaches } = r.value;
    const lines = beaches.map((b) => `- ${b.name} (${b.region}) slug: ${b.slug}`);
    const text = count
      ? `${count} beach${count === 1 ? "" : "es"}:\n${lines.join("\n")}\n${FOOTER}`
      : `No beaches match. Call list_beaches with no filter to see all coverage.\n${FOOTER}`;
    return { text, data: { count, beaches, ...common } };
  },
};

// ---- get_beach_score ---------------------------------------------------------

function conditionsText(c: BeachConditions): string {
  return [
    c.summary,
    c.limitedData ? "Note: this score uses limited live data." : "",
    `Updated ${c.updatedAt}; treat as current until ${c.validUntil}.`,
    `Beach page: ${c.url}`,
    FOOTER,
  ]
    .filter(Boolean)
    .join("\n");
}

const getBeachScore: ToolDef = {
  name: "get_beach_score",
  title: "Get a beach's score and safety lines",
  description:
    "Get the live Beach Day score (0-100) and rating for one beach, with the safety lines the website shows (lifeguard flag, rip current, lightning, rain, weather alerts, water quality), water temperature and today's best window. Use list_beaches or find_nearest_beach first to get the slug. The score is guidance only: lifeguard flags and posted warnings always win. When you repeat the result, include the attribution.",
  inputSchema: {
    type: "object",
    required: ["slug"],
    properties: {
      slug: { type: "string", maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: 'The beach slug from list_beaches, e.g. "boca-raton".' },
    },
    additionalProperties: false,
  },
  async run(args) {
    const slug = String(args.slug);
    if (!isValidSlug(slug)) return fail(`"${slug.slice(0, 64)}" is not a valid beach slug. Call list_beaches to see the slugs.`);
    const r = await loadBeachConditions(slug);
    if (r.status === "not_found") return fail(`No beach with slug "${slug}". Call list_beaches to see the slugs.`);
    if (r.status === "incomplete") return fail("Conditions are temporarily incomplete. Try again in about 30 seconds.");
    if (r.status === "expired") return fail("Conditions are being refreshed and the last reading is out of date. Try again in about 30 seconds.");
    return { text: conditionsText(r.conditions), data: { ...r.conditions } };
  },
};

// ---- find_nearest_beach ------------------------------------------------------

const findNearestBeach: ToolDef = {
  name: "find_nearest_beach",
  title: "Find the nearest beach",
  description: `Find the beaches nearest a latitude and longitude, measured to each beach's shoreline, with distance and direction. Returns up to ${MAX_MCP_NEAREST}. Set include_scores to also get a compact score for the nearest ${MAX_REST_SCORES}. Scores come from recent snapshots; a beach without one is listed as not scored right now (ask for it by slug with get_beach_score). Coverage is limited to the beaches in list_beaches; if none is close the result says so. The app does not store or log the coordinates; the answer echoes them rounded to 2 decimals.`,
  inputSchema: {
    type: "object",
    required: ["lat", "lon"],
    properties: {
      lat: { type: "number", minimum: -90, maximum: 90, description: "Latitude in decimal degrees." },
      lon: { type: "number", minimum: -180, maximum: 180, description: "Longitude in decimal degrees (west is negative)." },
      limit: { type: "integer", minimum: 1, maximum: MAX_MCP_NEAREST, default: 3, description: `How many beaches to return (1-${MAX_MCP_NEAREST}). Default 3.` },
      include_scores: { type: "boolean", default: false, description: `Also include a compact score for the nearest ${MAX_REST_SCORES} (from recent snapshots).` },
    },
    additionalProperties: false,
  },
  async run(args) {
    const limit = (args.limit as number | undefined) ?? 3;
    const withScores = args.include_scores === true;
    const r = await runNearest({
      lat: args.lat as number,
      lon: args.lon as number,
      limit,
      scoreCount: withScores ? Math.min(limit, MAX_REST_SCORES) : 0,
    });
    const data = r;
    const lines = r.beaches.map((b, i) => {
      const c = b.conditions;
      const tail = c ? ` ${c.summary}` : "";
      return `${i + 1}. ${b.name}, ${b.state ?? b.region}${dist(b)}, slug: ${b.slug}.${tail}`;
    });
    const text = [lines.join("\n"), r.note ?? "", FOOTER].filter(Boolean).join("\n");
    return { text, data: { ...data, ...common } };
  },
};

// ---- best_beach_today --------------------------------------------------------

interface RankedEntry extends CompactConditions {
  rank: number;
  slug: string;
  name: string;
  url: string;
  distanceMiles?: number;
  direction?: string;
}

const bestBeachToday: ToolDef = {
  name: "best_beach_today",
  title: "Pick the best beach today",
  description: `Compare a few beaches right now and pick the one with the highest Beach Day score for TODAY (for tomorrow or the weekend, use get_beach_outlook on one beach). Give a state or region, or a latitude and longitude (optionally with radius_miles), or both. Compares at most ${MAX_COMPARE} beaches (default ${DEFAULT_COMPARE}); with lat/lon it takes the nearest ones, otherwise the first ones in the list, and says which were left out. To protect the data sources it uses recent snapshots and builds at most one new one per call; beaches without a recent snapshot are listed as not compared right now (ask for them with get_beach_score). Each result has its safety summary, so mention any danger-level notice before recommending a beach. Lifeguard flags and posted warnings always win.`,
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", maxLength: 40, description: 'US state code or name, e.g. "FL".' },
      region: { type: "string", maxLength: 80, description: 'Text in the beach name or county, e.g. "Broward".' },
      lat: { type: "number", minimum: -90, maximum: 90, description: "Your latitude. Give with lon." },
      lon: { type: "number", minimum: -180, maximum: 180, description: "Your longitude. Give with lat." },
      radius_miles: { type: "number", minimum: 1, maximum: MAX_RADIUS_MILES, default: DEFAULT_RADIUS_MILES, description: `With lat/lon: only beaches within this many miles. Default ${DEFAULT_RADIUS_MILES}.` },
      compare: { type: "integer", minimum: 1, maximum: MAX_COMPARE, default: DEFAULT_COMPARE, description: `How many beaches to compare (1-${MAX_COMPARE}). Default ${DEFAULT_COMPARE}.` },
    },
    additionalProperties: false,
  },
  async run(args) {
    const lat = args.lat as number | undefined;
    const lon = args.lon as number | undefined;
    if ((lat === undefined) !== (lon === undefined)) return fail("Give both lat and lon, or neither.");
    const hasPoint = lat !== undefined && lon !== undefined;
    const stateRaw = args.state as string | undefined;
    const regionRaw = args.region as string | undefined;
    if (!hasPoint && stateRaw === undefined && regionRaw === undefined) {
      return fail("Say where to look: give a state or region, or a lat and lon.");
    }
    const filter = runListBeaches({ state: stateRaw, region: regionRaw });
    if (!filter.ok) return fail(filter.message);
    const pool: BeachSummary[] = filter.value.beaches;
    const compare = (args.compare as number | undefined) ?? DEFAULT_COMPARE;
    const radius = (args.radius_miles as number | undefined) ?? DEFAULT_RADIUS_MILES;

    let candidates: Array<BeachSummary & Partial<NearbyBeach>>;
    if (hasPoint) {
      candidates = nearestBeaches(lat, lon, pool.length, pool).filter((b) => b.distanceMiles <= radius);
    } else {
      candidates = pool;
    }
    if (!candidates.length) {
      const where = hasPoint ? `within ${radius} miles of that point${stateRaw || regionRaw ? " and that filter" : ""}` : "for that state or region";
      return {
        text: `No covered beaches ${where}. Try a larger radius_miles, or call list_beaches.\n${FOOTER}`,
        data: { best: null, ranking: [], skipped: [], notComparedNow: [], notCompared: [], candidateCount: 0, ...common },
      };
    }

    const picked = candidates.slice(0, compare);
    const left = candidates.slice(compare);
    const outcomes = await loadMany(picked.map((b) => b.slug));
    const byName = new Map(picked.map((b) => [b.slug, b]));

    const scored: Array<{ b: (typeof picked)[number]; c: BeachConditions }> = [];
    const skipped: Array<{ slug: string; name: string; reason: string }> = [];
    const notComparedNow: Array<{ slug: string; name: string; reason: "no_recent_snapshot" }> = [];
    for (const o of outcomes) {
      const b = byName.get(o.slug)!;
      if (o.ok) scored.push({ b, c: o.conditions });
      else if (o.reason === "not_cached" || o.reason === "expired") notComparedNow.push({ slug: o.slug, name: b.name, reason: "no_recent_snapshot" });
      else skipped.push({ slug: o.slug, name: b.name, reason: o.reason });
    }
    // Highest score first; a beach with no usable score goes last; nearer breaks a tie.
    scored.sort((x, y) => {
      const sx = x.c.score ?? -1;
      const sy = y.c.score ?? -1;
      if (sy !== sx) return sy - sx;
      return (x.b.distanceMiles ?? 0) - (y.b.distanceMiles ?? 0);
    });
    const ranking: RankedEntry[] = scored.map(({ b, c }, i) => ({
      rank: i + 1,
      slug: b.slug,
      name: b.name,
      url: b.url,
      ...(b.distanceMiles != null ? { distanceMiles: b.distanceMiles, direction: b.direction } : {}),
      ...compactConditions(c),
    }));
    const best = ranking.find((r) => r.score != null) ?? null;
    const notCompared = left.map((b) => ({ slug: b.slug, name: b.name }));

    const notes: string[] = [];
    if (notCompared.length) {
      notes.push(
        hasPoint
          ? `${notCompared.length} farther beach${notCompared.length === 1 ? " was" : "es were"} not compared; raise compare (max ${MAX_COMPARE}) to include more.`
          : `${notCompared.length} more beach${notCompared.length === 1 ? "" : "es"} matched but were not compared. Give lat and lon to compare the ones nearest you.`,
      );
    }
    if (notComparedNow.length) {
      notes.push(
        `Not compared right now (no recent snapshot): ${notComparedNow.map((s) => `${s.name} (${s.slug})`).join(", ")}. Call get_beach_score for any of them.`,
      );
    }
    if (skipped.length) notes.push(`Could not build conditions for: ${skipped.map((s) => s.name).join(", ")}.`);
    if (!best) notes.push("No beach had a usable score right now.");
    if (best?.hasDangerAlert) notes.push(`Heads up: ${best.name} has a danger-level notice. Read its summary before going.`);

    const lines = ranking.map((r) => `${r.rank}. ${r.summary}${dist(r)}`);
    const headline = best ? `Best of ${ranking.length} compared: ${best.name} (${best.score}/100, ${best.rating}).` : "No clear pick.";
    const text = [headline, lines.join("\n"), notes.join(" "), FOOTER].filter(Boolean).join("\n");
    return {
      text,
      data: {
        best,
        ranking,
        skipped,
        notComparedNow,
        notCompared,
        candidateCount: candidates.length,
        comparedCount: picked.length,
        ...(notes.length ? { note: notes.join(" ") } : {}),
        ...common,
      },
    };
  },
};

// ---- get_beach_outlook -------------------------------------------------------

const getBeachOutlook: ToolDef = {
  name: "get_beach_outlook",
  title: "Get a beach's 1-3 day outlook",
  description: `Get a short forecast of the Beach Day score for one beach for the next 1-${MAX_OUTLOOK_DAYS} days (today counts as day 1; default ${DEFAULT_OUTLOOK_DAYS}): for each day the expected peak score and rating, the best window in the beach's local time, a short sky word, and any safety notes for that day. Use it for "how is tomorrow?" or "what about the weekend?" (it reaches at most ${MAX_OUTLOOK_DAYS} days ahead). It is a forecast, not a guarantee: check again the morning of. Future days carry no live lifeguard flags or alerts; for right-now safety use get_beach_score. Lifeguard flags and posted warnings always win. Use list_beaches or find_nearest_beach first to get the slug.`,
  inputSchema: {
    type: "object",
    required: ["slug"],
    properties: {
      slug: { type: "string", maxLength: 64, pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", description: 'The beach slug from list_beaches, e.g. "boca-raton".' },
      days: { type: "integer", minimum: 1, maximum: MAX_OUTLOOK_DAYS, default: DEFAULT_OUTLOOK_DAYS, description: `How many days, counting today as 1 (1-${MAX_OUTLOOK_DAYS}). Default ${DEFAULT_OUTLOOK_DAYS}.` },
    },
    additionalProperties: false,
  },
  async run(args) {
    const slug = String(args.slug);
    const days = (args.days as number | undefined) ?? DEFAULT_OUTLOOK_DAYS;
    if (!isValidSlug(slug)) return fail(`"${slug.slice(0, 64)}" is not a valid beach slug. Call list_beaches to see the slugs.`);
    const r = await loadBeachOutlook(slug, days);
    if (r.status === "not_found") return fail(`No beach with slug "${slug}". Call list_beaches to see the slugs.`);
    if (r.status === "incomplete") return fail("The forecast is temporarily incomplete. Try again in about 30 seconds.");
    if (r.status === "expired") return fail("The forecast is being refreshed and the last reading is out of date. Try again in about 30 seconds.");
    const o = r.outlook;
    return { text: `${o.summary}\nBeach page: ${o.url}\n${FOOTER}`, data: { ...o } };
  },
};

export const TOOLS: readonly ToolDef[] = [listBeaches, getBeachScore, findNearestBeach, bestBeachToday, getBeachOutlook];
export const TOOLS_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(TOOLS.map((t) => [t.name, t]));
export const TOOL_NAMES = TOOLS.map((t) => t.name);

