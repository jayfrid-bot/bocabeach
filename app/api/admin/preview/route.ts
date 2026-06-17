// Admin preview: POST { location } -> a full ConditionsResponse for an arbitrary
// (not-yet-configured) Location, so the console can live-render the dashboard.
// Gated like the rest of the admin surface.

import { getConditionsForLocation } from "@/lib/conditions";
import type { Location } from "@/lib/types";

export const dynamic = "force-dynamic";

function isLocation(v: unknown): v is Location {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.slug === "string" &&
    typeof l.name === "string" &&
    typeof l.lat === "number" &&
    Number.isFinite(l.lat) &&
    typeof l.lon === "number" &&
    Number.isFinite(l.lon) &&
    typeof l.timezone === "string" &&
    Array.isArray(l.cams)
  );
}

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const loc = (body as { location?: unknown })?.location;
  if (!isLocation(loc)) {
    return Response.json({ error: "invalid or missing location" }, { status: 400 });
  }

  try {
    const data = await getConditionsForLocation(loc);
    return Response.json(data);
  } catch {
    return Response.json({ error: "preview failed" }, { status: 500 });
  }
}
