// GET /api/v1/beaches — every beach the app covers. Read-only, no auth.
// Optional filters: ?state=FL (code or name) and ?region=Broward (text in the
// beach's region or name).

import { apiError, guardedGet, jsonOk, preflight } from "@/lib/agent/http";
import { BEACH_LIST_QUERY_KEYS, checkQueryKeys } from "@/lib/agent/params";
import { runListBeaches } from "@/lib/agent/queries";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

export function GET(req: Request) {
  return guardedGet(req, "/api/v1/beaches", () => {
    const sp = new URL(req.url).searchParams;
    const keys = checkQueryKeys(sp, BEACH_LIST_QUERY_KEYS);
    if (!keys.ok) return apiError(400, "bad_request", keys.message);
    const result = runListBeaches({ state: sp.get("state") ?? undefined, region: sp.get("region") ?? undefined });
    if (!result.ok) return apiError(400, "bad_request", result.message);
    // The list only changes with a deploy.
    return jsonOk(result.value, "public, s-maxage=3600");
  });
}
