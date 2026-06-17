// Admin add: POST { location } (+ ?dryRun=1) -> commit the new Location into
// config/locations.generated.json on the repo, which Netlify auto-deploys. The
// new beach is then a live, routable location. Gated; commit is rehearsable.

import { addLocationCommit } from "@/lib/admin/github";
import type { Location } from "@/lib/types";

export const dynamic = "force-dynamic";

function isLocation(v: unknown): v is Location {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.slug === "string" &&
    l.slug.length > 0 &&
    typeof l.name === "string" &&
    l.name.length > 0 &&
    typeof l.lat === "number" &&
    Number.isFinite(l.lat) &&
    typeof l.lon === "number" &&
    Number.isFinite(l.lon) &&
    typeof l.timezone === "string" &&
    l.timezone.length > 0 &&
    typeof l.noaaTideStationId === "string" &&
    typeof l.ndbcBuoyId === "string" &&
    Array.isArray(l.cams)
  );
}

export async function POST(req: Request): Promise<Response> {
  const dryRun = new URL(req.url).searchParams.get("dryRun") !== null;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const loc = (body as { location?: unknown })?.location;
  if (!isLocation(loc)) {
    return Response.json(
      { ok: false, error: "invalid location — needs slug, name, lat/lon, timezone, station ids, cams[]" },
      { status: 400 },
    );
  }

  const result = await addLocationCommit(loc, { dryRun });
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
