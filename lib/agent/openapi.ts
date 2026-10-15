// The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json.
// Hand-written. lib/agent/openapi.test.ts checks it against the route files on disk
// (every route has a path, every path has a route, query names match the code) and
// checks real route answers against these response schemas.

import {
  API_BASE_PATH,
  CREDIT,
  DEFAULT_NEAREST_LIMIT,
  LLMS_TXT_PATH,
  MAX_NEAREST_LIMIT,
  MAX_REST_SCORES,
  MCP_URL,
  SAFETY_NOTE,
  SITE_URL,
} from "@/lib/agent/constants";
import type { JsonSchema } from "@/lib/agent/schema";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const nullable = (type: string) => ({ type: [type, "null"] });

const schemas: Record<string, JsonSchema> = {
  Attribution: {
    type: "object",
    required: ["credit", "url", "dataSources"],
    properties: {
      credit: { type: "string", description: `Show this credit when you repeat the score: "${CREDIT}".` },
      url: { type: "string" },
      dataSources: { type: "array", items: { type: "string" } },
    },
  },
  WatchLine: {
    type: "object",
    required: ["kind", "text", "tone"],
    properties: {
      kind: { type: "string", enum: ["hazard", "safety", "water", "best", "more"] },
      text: { type: "string", description: "Short plain text, as shown on the website and the watch." },
      tone: { type: "string", enum: ["calm", "caution", "danger"] },
    },
  },
  Beach: {
    type: "object",
    required: ["slug", "name", "region", "state", "lat", "lon", "url"],
    properties: {
      slug: { type: "string", description: "Stable id. Use it in /beaches/{slug}." },
      name: { type: "string" },
      region: { type: "string", description: 'County and state, e.g. "Palm Beach County, FL".' },
      state: { ...nullable("string"), description: "Two-letter US state code." },
      lat: { type: "number" },
      lon: { type: "number" },
      url: { type: "string", description: "The beach's page on isitbeachday.com." },
    },
  },
  BeachList: {
    type: "object",
    required: ["count", "beaches"],
    properties: { count: { type: "integer" }, beaches: { type: "array", items: ref("Beach") } },
  },
  BeachConditions: {
    type: "object",
    required: [
      "v", "slug", "name", "region", "state", "url", "lat", "lon", "score", "rating", "band", "limitedData",
      "summary", "lines", "waterTempF", "bestTime", "generatedAt", "updatedAt", "capturedAt", "validUntil",
      "safetyNote", "disclaimer", "attribution",
    ],
    properties: {
      v: { const: 1 },
      slug: { type: "string" },
      name: { type: "string" },
      region: { type: "string" },
      state: nullable("string"),
      url: { type: "string" },
      lat: { type: "number" },
      lon: { type: "number" },
      score: { ...nullable("integer"), minimum: 0, maximum: 100, description: "Beach Day score, 0-100. Null when there was not enough live data." },
      rating: { ...nullable("string"), description: "Excellent, Good, Decent, Marginal or Poor." },
      band: nullable("string"),
      limitedData: { type: "boolean", description: "True when the score was built from too little live data." },
      summary: { type: "string", description: "One plain sentence you can read out." },
      lines: { type: "array", items: ref("WatchLine"), description: "Safety lines first (worst first), then water temperature and best time." },
      waterTempF: nullable("integer"),
      bestTime: { ...nullable("string"), description: 'Best window today in the beach\'s own time zone, e.g. "4–6 PM".' },
      generatedAt: nullable("string"),
      updatedAt: { type: "string", description: "When the underlying data was last built (ISO 8601)." },
      capturedAt: { type: "string" },
      validUntil: { type: "string", description: "After this moment, do not call the answer current." },
      safetyNote: { type: "string", const: SAFETY_NOTE },
      disclaimer: { type: "string" },
      attribution: ref("Attribution"),
    },
  },
  CompactConditions: {
    type: "object",
    required: ["score", "rating", "limitedData", "summary", "hasDangerAlert", "updatedAt", "validUntil"],
    properties: {
      score: { ...nullable("integer"), minimum: 0, maximum: 100 },
      rating: nullable("string"),
      limitedData: { type: "boolean" },
      summary: { type: "string" },
      hasDangerAlert: { type: "boolean" },
      updatedAt: { type: "string" },
      validUntil: { type: "string" },
    },
  },
  NearbyBeach: {
    type: "object",
    required: ["slug", "name", "region", "state", "lat", "lon", "url", "distanceMiles", "distanceKm", "bearingDeg", "direction"],
    properties: {
      slug: { type: "string" },
      name: { type: "string" },
      region: { type: "string" },
      state: nullable("string"),
      lat: { type: "number" },
      lon: { type: "number" },
      url: { type: "string" },
      distanceMiles: { type: "number", description: "Miles to the closest point on the beach's shoreline." },
      distanceKm: { type: "number" },
      bearingDeg: { type: "integer", minimum: 0, maximum: 359, description: "Compass bearing from your point to the sand (0 = north)." },
      direction: { type: "string", description: 'The bearing as a compass word, e.g. "NE".' },
      conditions: {
        description: `Present only with scores=true, for the nearest ${MAX_REST_SCORES} beaches. Null when a score could not be built.`,
        oneOf: [ref("CompactConditions"), { type: "null" }],
      },
    },
  },
  NearestResponse: {
    type: "object",
    required: ["query", "count", "scored", "beaches"],
    properties: {
      query: {
        type: "object",
        required: ["lat", "lon", "limit"],
        properties: { lat: { type: "number" }, lon: { type: "number" }, limit: { type: "integer" } },
      },
      count: { type: "integer" },
      scored: { type: "integer", description: "How many beaches carry a live score in this answer." },
      beaches: { type: "array", items: ref("NearbyBeach") },
      note: { type: "string" },
    },
  },
  Error: {
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: {
            type: "string",
            enum: ["bad_request", "not_found", "rate_limited", "unavailable", "method_not_allowed", "internal_error"],
          },
          message: { type: "string" },
        },
      },
    },
  },
};

const errorResponse = (description: string) => ({
  description,
  content: { "application/json": { schema: ref("Error") } },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": { schema: { type: "string", const: "*" } },
};

const rateLimited = {
  ...errorResponse("Too many requests from this address. Wait for Retry-After seconds."),
  headers: { "Retry-After": { schema: { type: "integer" } }, ...corsHeaders },
};

export function buildOpenApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Is It Beach Day API",
      version: "1.0.0",
      summary: "Live beach scores and safety lines for US beaches. Read-only, no key.",
      description: [
        "Live Beach Day scores (0-100), swim-safety lines, water temperature and best time for the beaches covered by Is It Beach Day.",
        "Free to use and open to browsers and agents. No account or key. Please keep to a few requests per minute and cache answers until `validUntil`.",
        `Always show the credit: "${CREDIT}". ${SAFETY_NOTE}`,
        `Also available as an MCP server at ${MCP_URL}. A plain-text guide is at ${SITE_URL}${LLMS_TXT_PATH}.`,
      ].join("\n\n"),
      termsOfService: `${SITE_URL}/privacy`,
      contact: { name: "Is It Beach Day", email: "hello@isitbeachday.com", url: SITE_URL },
    },
    servers: [{ url: `${SITE_URL}${API_BASE_PATH}` }],
    externalDocs: { description: "Guide for agents", url: `${SITE_URL}${LLMS_TXT_PATH}` },
    tags: [{ name: "beaches" }, { name: "meta" }],
    paths: {
      "/beaches": {
        get: {
          operationId: "listBeaches",
          tags: ["beaches"],
          summary: "List every covered beach",
          parameters: [
            {
              name: "state",
              in: "query",
              required: false,
              description: 'Two-letter code or full name, e.g. "FL" or "Florida".',
              schema: { type: "string", maxLength: 40 },
            },
            {
              name: "region",
              in: "query",
              required: false,
              description: 'Text found in the beach name or region, e.g. "Broward".',
              schema: { type: "string", maxLength: 80 },
            },
          ],
          responses: {
            "200": {
              description: "The beaches, in the order the app lists them.",
              headers: corsHeaders,
              content: { "application/json": { schema: ref("BeachList") } },
            },
            "400": errorResponse("Unknown state or query parameter."),
            "429": rateLimited,
          },
        },
      },
      "/beaches/{slug}": {
        get: {
          operationId: "getBeach",
          tags: ["beaches"],
          summary: "Live conditions for one beach",
          description:
            "The same answer the website and the Apple Watch app show. Cached at the edge for at most 60 seconds and never past `validUntil`.",
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              description: "A slug from /beaches.",
              schema: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 },
            },
          ],
          responses: {
            "200": {
              description: "Current conditions.",
              headers: corsHeaders,
              content: { "application/json": { schema: ref("BeachConditions") } },
            },
            "400": errorResponse("A query parameter was given. This route takes none."),
            "404": errorResponse("Unknown beach."),
            "429": rateLimited,
            "503": errorResponse("Conditions were incomplete. Retry after the Retry-After seconds."),
          },
        },
      },
      "/nearest": {
        get: {
          operationId: "findNearestBeaches",
          tags: ["beaches"],
          summary: "Beaches nearest a point",
          description: `Measured to the closest point on each beach's shoreline. With scores=true the nearest ${MAX_REST_SCORES} beaches also carry a compact live score. The coordinates are not stored or logged.`,
          parameters: [
            { name: "lat", in: "query", required: true, description: "Latitude, -90 to 90.", schema: { type: "number", minimum: -90, maximum: 90 } },
            { name: "lon", in: "query", required: true, description: "Longitude, -180 to 180.", schema: { type: "number", minimum: -180, maximum: 180 } },
            {
              name: "limit",
              in: "query",
              required: false,
              description: `How many beaches to return, 1 to ${MAX_NEAREST_LIMIT}. Default ${DEFAULT_NEAREST_LIMIT}.`,
              schema: { type: "integer", minimum: 1, maximum: MAX_NEAREST_LIMIT, default: DEFAULT_NEAREST_LIMIT },
            },
            {
              name: "scores",
              in: "query",
              required: false,
              description: `Include a compact live score for the nearest ${MAX_REST_SCORES} beaches. Default false.`,
              schema: { type: "boolean", default: false },
            },
          ],
          responses: {
            "200": {
              description: "Beaches, nearest first.",
              headers: corsHeaders,
              content: { "application/json": { schema: ref("NearestResponse") } },
            },
            "400": errorResponse("Missing or out-of-range lat, lon, limit or scores."),
            "429": rateLimited,
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi",
          tags: ["meta"],
          summary: "This document",
          responses: {
            "200": { description: "The OpenAPI 3.1 description.", headers: corsHeaders, content: { "application/json": { schema: { type: "object" } } } },
            "429": rateLimited,
          },
        },
      },
    },
    components: { schemas },
  };
}
