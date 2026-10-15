// GET /api/v1/nearest?lat=&lon=&limit=&scores= — the closest beaches to a point,
// measured to each beach's shoreline. With scores=true, the nearest few (at most
// MAX_REST_SCORES) also carry a compact live score; the cap protects the upstream
// data sources. Scores come from the shared conditions cache; at most one beach per
// request is built cold. The app does not store or log the coordinates; the answer
// echoes them rounded to 2 decimals and is never cached (no-store).

import { MAX_NEAREST_LIMIT, DEFAULT_NEAREST_LIMIT, MAX_REST_SCORES } from "@/lib/agent/constants";
import { apiError, guardedGet, jsonOk, preflight, methodNotAllowed } from "@/lib/agent/http";
import {
  LAT_RANGE,
  LON_RANGE,
  NEAREST_QUERY_KEYS,
  checkQueryKeys,
  parseBool,
  parseInteger,
  parseNumber,
} from "@/lib/agent/params";
import { runNearest } from "@/lib/agent/queries";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

// Read-only: every other method gets the JSON error shape with CORS (not Next's bare 405).
const notAllowed = (req: Request) => methodNotAllowed(req, "/api/v1/nearest");
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

export function GET(req: Request) {
  return guardedGet(req, "/api/v1/nearest", async () => {
    const sp = new URL(req.url).searchParams;
    const keys = checkQueryKeys(sp, NEAREST_QUERY_KEYS);
    if (!keys.ok) return apiError(400, "bad_request", keys.message);

    const latRaw = sp.get("lat");
    const lonRaw = sp.get("lon");
    if (latRaw === null || lonRaw === null) return apiError(400, "bad_request", "lat and lon are required.");
    const lat = parseNumber(latRaw, "lat", LAT_RANGE[0], LAT_RANGE[1]);
    if (!lat.ok) return apiError(400, "bad_request", lat.message);
    const lon = parseNumber(lonRaw, "lon", LON_RANGE[0], LON_RANGE[1]);
    if (!lon.ok) return apiError(400, "bad_request", lon.message);

    let limit = DEFAULT_NEAREST_LIMIT;
    const limitRaw = sp.get("limit");
    if (limitRaw !== null) {
      const p = parseInteger(limitRaw, "limit", 1, MAX_NEAREST_LIMIT);
      if (!p.ok) return apiError(400, "bad_request", p.message);
      limit = p.value;
    }
    let withScores = false;
    const scoresRaw = sp.get("scores");
    if (scoresRaw !== null) {
      const p = parseBool(scoresRaw, "scores");
      if (!p.ok) return apiError(400, "bad_request", p.message);
      withScores = p.value;
    }

    const scoreCount = withScores ? Math.min(limit, MAX_REST_SCORES) : 0;
    const result = await runNearest({ lat: lat.value, lon: lon.value, limit, scoreCount });
    // The URL carries a location, so no cache keeps this answer.
    return jsonOk(result, "no-store");
  });
}
