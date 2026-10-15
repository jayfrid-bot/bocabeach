// GET /api/v1/openapi.json — the OpenAPI 3.1 description of /api/v1.
// lib/agent/openapi.ts is the source; its test keeps it in step with the routes.

import { guardedGet, jsonOk, preflight } from "@/lib/agent/http";
import { buildOpenApi } from "@/lib/agent/openapi";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

export function GET(req: Request) {
  return guardedGet(req, "/api/v1/openapi.json", () => jsonOk(buildOpenApi(), "public, s-maxage=3600"));
}
