// GET /api/v1/beaches/{slug}/outlook?days= — a 1-3 day score outlook for one beach
// (today counts as day 1; default 3). Per day: expected peak score and rating, best
// window in the beach's local time, a sky word and safety notes. It is a
// forecast, not a guarantee. Built from the same multi-day windows as the website's
// "best beach times for the next few days" (lib/agent/outlook.ts).
//
// Cost: reads the shared 120-s conditions cache or builds this ONE beach. Cache: same rule
// as /beaches/{slug} (s-maxage = min(60, seconds until validUntil), else no-store).

import { MAX_OUTLOOK_DAYS, DEFAULT_OUTLOOK_DAYS } from "@/lib/agent/constants";
import { apiError, guardedGet, jsonOk, preflight, methodNotAllowed } from "@/lib/agent/http";
import { loadBeachOutlook } from "@/lib/agent/outlook";
import { OUTLOOK_QUERY_KEYS, checkQueryKeys, parseInteger } from "@/lib/agent/params";
import { isValidSlug, viewCacheControl } from "@/lib/watchLoad";

export const dynamic = "force-dynamic";

const NOT_FOUND_CACHE = "public, s-maxage=300";

export function OPTIONS() {
  return preflight();
}

// Read-only: every other method gets the JSON error shape with CORS (not Next's bare 405).
const notAllowed = (req: Request) => methodNotAllowed(req, "/api/v1/beaches/[slug]/outlook");
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

export function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  return guardedGet(req, "/api/v1/beaches/[slug]/outlook", async () => {
    const sp = new URL(req.url).searchParams;
    const keys = checkQueryKeys(sp, OUTLOOK_QUERY_KEYS);
    if (!keys.ok) return apiError(400, "bad_request", keys.message);
    let days = DEFAULT_OUTLOOK_DAYS;
    const daysRaw = sp.get("days");
    if (daysRaw !== null) {
      const p = parseInteger(daysRaw, "days", 1, MAX_OUTLOOK_DAYS);
      if (!p.ok) return apiError(400, "bad_request", p.message);
      days = p.value;
    }
    const { slug } = await ctx.params;
    const notFound = () =>
      apiError(404, "not_found", `No beach with slug "${slug.slice(0, 64)}". List slugs at /api/v1/beaches.`, {
        cacheControl: NOT_FOUND_CACHE,
      });
    if (!isValidSlug(slug)) return notFound();
    const loaded = await loadBeachOutlook(slug, days);
    if (loaded.status === "not_found") return notFound();
    if (loaded.status === "incomplete" || loaded.status === "expired") {
      return apiError(
        503,
        "unavailable",
        loaded.status === "incomplete"
          ? "The forecast is temporarily incomplete. Try again in 30 seconds."
          : "The forecast is being refreshed and the last reading is out of date. Try again in 30 seconds.",
        { retryAfterSec: 30 },
      );
    }
    return jsonOk(loaded.outlook, viewCacheControl(loaded.outlook));
  });
}
