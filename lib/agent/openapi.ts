// The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json.
// Hand-written. lib/agent/openapi.test.ts checks it against the route files on disk
// (every route has a path, every path has a route, query names match the code) and
// checks real route answers against these response schemas.

import { LAT_PATTERN, LON_PATTERN, MAX_REGION_LEN, MAX_STATE_LEN, TEXT_PARAM_PATTERN } from "@/lib/agent/params";
import {
  API_BASE_PATH,
  CREDIT,
  DEFAULT_NEAREST_LIMIT,
  DEFAULT_OUTLOOK_DAYS,
  LLMS_TXT_PATH,
  MAX_NEAREST_LIMIT,
  MAX_OUTLOOK_DAYS,
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
        description: "The point asked about, rounded to 2 decimals. Distances use the exact point.",
        required: ["lat", "lon", "limit"],
        properties: { lat: { type: "number" }, lon: { type: "number" }, limit: { type: "integer" } },
      },
      count: { type: "integer" },
      scored: { type: "integer", description: "How many beaches carry a score in this answer." },
      beaches: { type: "array", items: ref("NearbyBeach") },
      note: { type: "string" },
    },
  },
  OutlookWindow: {
    type: "object",
    required: ["startIso", "endIso", "text", "score", "rating", "good"],
    properties: {
      startIso: { type: "string" },
      endIso: { type: "string" },
      text: { type: "string", description: 'Local time at the beach, e.g. "10 AM–1 PM".' },
      score: { type: "integer", minimum: 0, maximum: 100, description: "Score of the window's best hour." },
      rating: { type: "string" },
      good: { type: "boolean", description: "True when the window reaches Decent (65) or better, the bar the app uses to say it is a good time to go." },
    },
  },
  OutlookDay: {
    type: "object",
    required: ["date", "weekday", "label", "peakScore", "rating", "bestWindow", "sky", "notes", "summary"],
    properties: {
      date: { type: "string", description: "YYYY-MM-DD in the beach's local time." },
      weekday: { type: "string", description: 'Full weekday name, e.g. "Saturday".' },
      label: { type: "string", description: '"Today", "Tomorrow" or the weekday.' },
      peakScore: { ...nullable("integer"), minimum: 0, maximum: 100, description: "Expected peak Beach Day score for the day. Null when no hours scored." },
      rating: { ...nullable("string"), description: "Excellent, Good, Decent, Marginal or Poor." },
      bestWindow: { description: "Best stretch of daylight. Null when none is left (today after it ended) or none scored.", oneOf: [ref("OutlookWindow"), { type: "null" }] },
      sky: { ...nullable("string"), description: 'Short sky word, e.g. "Mostly Sunny".' },
      notes: { type: "array", items: { type: "string" }, description: "Safety notes for the peak hour (the caps the score model applied). Empty when there are none." },
      summary: { type: "string" },
    },
  },
  BeachOutlook: {
    type: "object",
    required: [
      "v", "slug", "name", "region", "state", "url", "timezone", "requestedDays", "days", "summary", "forecastNote",
      "generatedAt", "updatedAt", "capturedAt", "validUntil", "safetyNote", "disclaimer", "attribution",
    ],
    properties: {
      v: { const: 1 },
      slug: { type: "string" },
      name: { type: "string" },
      region: { type: "string" },
      state: nullable("string"),
      url: { type: "string" },
      timezone: { type: "string", description: "IANA time zone of the dates and window times." },
      requestedDays: { type: "integer", minimum: 1, maximum: MAX_OUTLOOK_DAYS },
      days: { type: "array", items: ref("OutlookDay"), description: "Today first. Fewer than requested when forecast data is missing; see note." },
      summary: { type: "string", description: "One paragraph you can read out. Ends with the forecast note." },
      forecastNote: { type: "string", description: "Forecast, not a guarantee; check again the morning of." },
      note: { type: "string", description: "Present when fewer days than asked for are available." },
      generatedAt: nullable("string"),
      updatedAt: { type: "string" },
      capturedAt: { type: "string" },
      validUntil: { type: "string", description: "After this moment, do not call the answer current." },
      safetyNote: { type: "string", const: SAFETY_NOTE },
      disclaimer: { type: "string" },
      attribution: ref("Attribution"),
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

const serverError = errorResponse("Something went wrong on our side. Try again shortly.");

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
        "Free to use and open to browsers and agents. No account or key. Requests are limited to about 60 per minute per IP address. Answers carry `validUntil`; do not call an answer current after it. Query parameters must be written in one canonical form (see each parameter); anything else is a 400.",
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
              description: 'Two-letter code or full name, e.g. "FL" or "Florida". Not empty, no space at either end.',
              schema: { type: "string", minLength: 1, maxLength: MAX_STATE_LEN, pattern: TEXT_PARAM_PATTERN },
            },
            {
              name: "region",
              in: "query",
              required: false,
              description: 'Text found in the beach name or region, e.g. "Broward". Not empty, no space at either end. Longer values are refused, not cut.',
              schema: { type: "string", minLength: 1, maxLength: MAX_REGION_LEN, pattern: TEXT_PARAM_PATTERN },
            },
          ],
          responses: {
            "200": {
              description: "The beaches, in the order the app lists them.",
              headers: corsHeaders,
              content: { "application/json": { schema: ref("BeachList") } },
            },
            "400": errorResponse("Unknown state, a value that is not in canonical form, or an unknown or repeated query parameter."),
            "429": rateLimited,
            "500": serverError,
          },
        },
      },
      "/beaches/{slug}": {
        get: {
          operationId: "getBeach",
          tags: ["beaches"],
          summary: "Live conditions for one beach",
          description:
            "The same answer the website and the Apple Watch app show. The response sends `Cache-Control: public, s-maxage=<seconds>` (at most 60, never past `validUntil`, `no-store` once expired) as a hint for downstream caches; the app itself reads a shared 120-second conditions cache and keeps no response cache. Other methods than GET answer 405 with the same error shape.",
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
            "500": serverError,
            "503": {
              ...errorResponse("Conditions were incomplete, or the last reading was already out of date and is being refreshed. Retry after the Retry-After seconds."),
              headers: { "Retry-After": { schema: { type: "integer" } }, ...corsHeaders },
            },
          },
        },
      },
      "/beaches/{slug}/outlook": {
        get: {
          operationId: "getBeachOutlook",
          tags: ["beaches"],
          summary: "A 1-3 day score outlook for one beach",
          description: `For each of the next ${MAX_OUTLOOK_DAYS} calendar days at most (today counts as day 1): the expected peak Beach Day score and rating, the best window in the beach's local time, a sky word and any safety notes for that day. It comes from the same forecast the website shows under "best beach times for the next few days". It is a forecast, not a guarantee: check again the morning of. Future days carry no live lifeguard flags or alerts; use /beaches/{slug} for right now. The response is cached like /beaches/{slug} (\`Cache-Control: public, s-maxage=<seconds>\`, at most 60, never past \`validUntil\`).`,
          parameters: [
            {
              name: "slug",
              in: "path",
              required: true,
              description: "A slug from /beaches.",
              schema: { type: "string", pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 64 },
            },
            {
              name: "days",
              in: "query",
              required: false,
              description: `How many calendar days, counting today as 1, from 1 to ${MAX_OUTLOOK_DAYS}. Default ${DEFAULT_OUTLOOK_DAYS}. No leading zeros.`,
              schema: { type: "string", pattern: `^[1-${MAX_OUTLOOK_DAYS}]$`, default: String(DEFAULT_OUTLOOK_DAYS) },
            },
          ],
          responses: {
            "200": {
              description: "The outlook, today first.",
              headers: corsHeaders,
              content: { "application/json": { schema: ref("BeachOutlook") } },
            },
            "400": errorResponse("days out of range or not canonical, or an unknown or repeated query parameter."),
            "404": errorResponse("Unknown beach."),
            "429": rateLimited,
            "500": serverError,
            "503": {
              ...errorResponse("The forecast was incomplete, or the last reading was already out of date and is being refreshed. Retry after the Retry-After seconds."),
              headers: { "Retry-After": { schema: { type: "integer" } }, ...corsHeaders },
            },
          },
        },
      },
      "/nearest": {
        get: {
          operationId: "findNearestBeaches",
          tags: ["beaches"],
          summary: "Beaches nearest a point",
          description: `Measured to the closest point on each beach's shoreline. With scores=true the nearest ${MAX_REST_SCORES} beaches try to carry a compact score from a recent view kept for that beach; at most one beach per request is built fresh, and a beach without a recent view has conditions null and is named in \`note\`. The coordinates are not stored or logged by the app. The answer echoes them rounded to 2 decimals and is sent with Cache-Control: no-store.`,
          parameters: [
            {
              name: "lat",
              in: "query",
              required: true,
              description: "Latitude, -90 to 90 (the pattern enforces the range). A plain decimal of at most 24 characters: no spaces, plus sign, exponent, leading zeros or negative zero (26.35, not 026.35, 2.635e1 or -0).",
              schema: { type: "string", maxLength: 24, pattern: LAT_PATTERN, examples: ["26.35"] },
            },
            {
              name: "lon",
              in: "query",
              required: true,
              description: "Longitude, -180 to 180 (the pattern enforces the range). Same plain-decimal form as lat.",
              schema: { type: "string", maxLength: 24, pattern: LON_PATTERN, examples: ["-80.07"] },
            },
            {
              name: "limit",
              in: "query",
              required: false,
              description: `How many beaches to return, 1 to ${MAX_NEAREST_LIMIT}. Default ${DEFAULT_NEAREST_LIMIT}. No leading zeros.`,
              schema: { type: "string", pattern: `^([1-9]|${MAX_NEAREST_LIMIT})$`, default: String(DEFAULT_NEAREST_LIMIT) },
            },
            {
              name: "scores",
              in: "query",
              required: false,
              description: `Exactly "true" or "false". With true, the nearest ${MAX_REST_SCORES} beaches also try to carry a compact score. Default false.`,
              schema: { type: "string", enum: ["true", "false"], default: "false" },
            },
          ],
          responses: {
            "200": {
              description: "Beaches, nearest first.",
              headers: corsHeaders,
              content: { "application/json": { schema: ref("NearestResponse") } },
            },
            "400": errorResponse("Missing, out-of-range or non-canonical lat, lon, limit or scores, or an unknown or repeated query parameter."),
            "429": rateLimited,
            "500": serverError,
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApi",
          tags: ["meta"],
          summary: "This document",
          responses: {
            "400": errorResponse("This route takes no query parameters."),
            "200": { description: "The OpenAPI 3.1 description.", headers: corsHeaders, content: { "application/json": { schema: { type: "object" } } } },
            "429": rateLimited,
            "500": serverError,
          },
        },
      },
    },
    components: { schemas },
  };
}
