// Shared facts for the public agent surface: the v1 JSON API, the OpenAPI spec,
// llms.txt and the MCP server. One place, so the wording never drifts.

export const SITE_URL = "https://isitbeachday.com";
export const API_BASE_PATH = "/api/v1";
export const MCP_PATH = "/mcp";
export const MCP_URL = `${SITE_URL}${MCP_PATH}`;
export const OPENAPI_PATH = `${API_BASE_PATH}/openapi.json`;
export const LLMS_TXT_PATH = "/llms.txt";

export const CREDIT = "Score by Is It Beach Day — isitbeachday.com";

/** Where the numbers come from. Short on purpose; the beach page lists the sources it used. */
export const DATA_SOURCES: readonly string[] = [
  "NOAA / National Weather Service (alerts, forecasts, surf-zone and rip current guidance)",
  "NOAA tide gauges and NDBC buoys",
  "NOAA MRMS radar, GOES satellite and GLM lightning data",
  "Open-Meteo and MET Norway weather models",
  "EPA AirNow air quality",
  "City and lifeguard beach reports, and state water-quality programs, where a beach has them",
];

export const SAFETY_NOTE = "Lifeguard flags and posted warnings always win.";

export const ATTRIBUTION = {
  credit: CREDIT,
  url: SITE_URL,
  dataSources: DATA_SOURCES,
} as const;

export const DISCLAIMER =
  "The score is an automated estimate for general guidance, not a safety determination.";

// ---- limits -----------------------------------------------------------------

/** Most beaches one /nearest call may return. */
export const MAX_NEAREST_LIMIT = 10;
/** Default number of beaches for /nearest. */
export const DEFAULT_NEAREST_LIMIT = 5;
/** Most beaches one REST request may build live scores for (protects upstream). */
export const MAX_REST_SCORES = 3;
/** Most beaches the MCP find_nearest_beach tool returns. */
export const MAX_MCP_NEAREST = 5;
/** Most beaches best_beach_today may compare in one call. */
export const MAX_COMPARE = 5;
export const DEFAULT_COMPARE = 3;
export const DEFAULT_RADIUS_MILES = 60;
export const MAX_RADIUS_MILES = 250;
/** get_beach_outlook / GET .../outlook: calendar days, counting today as day 1. */
export const MAX_OUTLOOK_DAYS = 3;
export const DEFAULT_OUTLOOK_DAYS = 3;
export const OUTLOOK_NOTE = "Forecast, not a guarantee; check again the morning of.";
/**
 * Most JSON-RPC messages in one batch POST (2025-03-26 clients), and most tools/call among them.
 * One tools/call per batch: a batch costs one rate-limit token, so letting it carry several
 * tool calls (each can start a data build) would be a way around the per-request limits.
 * Pings, tools/list and notifications are cheap and stay uncapped within MCP_MAX_BATCH.
 */
export const MCP_MAX_BATCH = 10;
export const MCP_MAX_BATCH_TOOL_CALLS = 1;
/** Request body cap for /mcp, in bytes. */
export const MCP_MAX_BODY_BYTES = 32 * 1024;
/** A nearest beach farther than this gets a "nothing close" note. */
export const FAR_AWAY_MILES = 100;
