// GET /api/v1/openapi.json — the OpenAPI 3.1 description of /api/v1.
// lib/agent/openapi.ts is the source; its test keeps it in step with the routes.

import { apiError, guardedGet, jsonOk, preflight, methodNotAllowed } from "@/lib/agent/http";
import { buildOpenApi } from "@/lib/agent/openapi";

export const dynamic = "force-dynamic";

export function OPTIONS() {
  return preflight();
}

// Read-only: every other method gets the JSON error shape with CORS (not Next's bare 405).
const notAllowed = (req: Request) => methodNotAllowed(req, "/api/v1/openapi.json");
export const POST = notAllowed;
export const PUT = notAllowed;
export const PATCH = notAllowed;
export const DELETE = notAllowed;

export function GET(req: Request) {
  return guardedGet(req, "/api/v1/openapi.json", () => {
    // Takes no query string, so junk cannot mint distinct URLs.
    if (new URL(req.url).search !== "") return apiError(400, "bad_request", "This route takes no query parameters.");
    return jsonOk(buildOpenApi(), "public, s-maxage=3600");
  });
}
