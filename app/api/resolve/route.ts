// Resolver endpoint: GET /api/resolve?q=<query>&pick=<n>.
//
// Runs the free-text location resolver and returns its status, candidates,
// warnings, a paste-ready Location snippet (when resolved), and a human report.
// Backs the /admin/yf console; read-only (only resolves names, no writes).

import { resolveBeach } from "@/lib/resolve/resolveLocation";
import { emitLocationSnippet, emitReport } from "@/lib/resolve/emit";
import { checkRateLimit, clientIp } from "@/lib/plus/rateLimit";

export const dynamic = "force-dynamic";

// Public endpoint: geocoding + station lookups cost several upstream calls
// (Open-Meteo free tier is 10,000/day), so an anonymous caller is capped at
// 10 resolutions/hour/IP. Same fixed-window limiter as /api/devices/unlock.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_QUERY_LEN = 200;

function rateLimited(retryAfterSec: number): Response {
  return Response.json(
    { error: "too-many-requests" },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } },
  );
}

export async function GET(req: Request): Promise<Response> {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  if (!q || q.length > MAX_QUERY_LEN) {
    return Response.json({ error: "Missing ?q=" }, { status: 400 });
  }

  const ip = clientIp(req) ?? "unknown";
  const limit = await checkRateLimit(`resolve:ip:${ip}`, MAX_ATTEMPTS, WINDOW_MS);
  if (limit.limited) return rateLimited(limit.retryAfterSec);

  const pickParamRaw = searchParams.get("pick");
  const pickParsed = pickParamRaw !== null ? Number(pickParamRaw) : NaN;
  const pick = Number.isInteger(pickParsed) && pickParsed >= 0 ? pickParsed : undefined;

  const result = await resolveBeach(q, pick !== undefined ? { pick } : {});

  return Response.json({
    status: result.status,
    candidates: result.candidates,
    warnings: result.warnings,
    snippet: result.location ? emitLocationSnippet(result) : undefined,
    report: emitReport(result),
    location: result.location,
  });
}
