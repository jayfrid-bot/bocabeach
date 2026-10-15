// GET /api/v1/beaches/{slug} — one beach's live answer: score, rating, safety
// lines, water temperature, best time, page link and attribution. It is the Apple
// Watch view (lib/watchView.ts) with a few agent fields added, so the website, the
// watch and assistants never disagree.
//
// Cache: s-maxage = min(60, seconds until validUntil); none left = no-store; never
// stale-while-revalidate (same rule as /api/watch). A partial build is a 503.

import { loadBeachConditions } from "@/lib/agent/beachView";
import { apiError, guardedGet, jsonOk, preflight } from "@/lib/agent/http";
import { checkQueryKeys } from "@/lib/agent/params";
import { isValidSlug, viewCacheControl } from "@/lib/watchLoad";

export const dynamic = "force-dynamic";

const NOT_FOUND_CACHE = "public, s-maxage=300";

export function OPTIONS() {
  return preflight();
}

export function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  return guardedGet(req, "/api/v1/beaches/[slug]", async () => {
    const keys = checkQueryKeys(new URL(req.url).searchParams, []);
    if (!keys.ok) return apiError(400, "bad_request", keys.message);
    const { slug } = await ctx.params;
    const notFound = () =>
      apiError(404, "not_found", `No beach with slug "${slug.slice(0, 64)}". List slugs at /api/v1/beaches.`, {
        cacheControl: NOT_FOUND_CACHE,
      });
    if (!isValidSlug(slug)) return notFound();
    const loaded = await loadBeachConditions(slug);
    if (loaded.status === "not_found") return notFound();
    if (loaded.status === "incomplete") {
      return apiError(503, "unavailable", "Conditions are temporarily incomplete. Try again in 30 seconds.", {
        retryAfterSec: 30,
      });
    }
    return jsonOk(loaded.conditions, viewCacheControl(loaded.conditions));
  });
}
