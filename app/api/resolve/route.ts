// Resolver endpoint: GET /api/resolve?q=<query>&pick=<n>.
//
// Runs the free-text location resolver and returns its status, candidates,
// warnings, a paste-ready Location snippet (when resolved), and a human report.
// Authoring/curation tool — open in dev, and in production only behind the admin
// token (so the admin console can use it). Not a public API.

import { resolveBeach } from "@/lib/resolve/resolveLocation";
import { emitLocationSnippet, emitReport } from "@/lib/resolve/emit";
import { adminApiAllowed } from "@/lib/admin/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  if (!adminApiAllowed(req)) {
    return new Response("Not found", { status: 404 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  if (!q) {
    return Response.json({ error: "Missing ?q=" }, { status: 400 });
  }

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
