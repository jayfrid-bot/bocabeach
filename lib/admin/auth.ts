// Admin-surface gating. The admin console + its APIs are protected by a single
// secret token (the `ADMIN_TOKEN` env var) that doubles as the secret URL
// segment (/admin/<token>). It FAILS CLOSED in production: with no token set,
// nothing admin renders. Local dev is open for convenience.

const isProd = () => process.env.NODE_ENV === "production";

/** The configured admin secret, or undefined when admin is disabled. */
export function adminToken(): string | undefined {
  const t = process.env.ADMIN_TOKEN?.trim();
  return t ? t : undefined;
}

/** True only when `token` matches the configured secret (which must be set). */
export function isValidAdminToken(token: string | null | undefined): boolean {
  const expected = adminToken();
  if (!expected) return false; // no secret configured -> admin disabled
  return typeof token === "string" && token.length > 0 && token === expected;
}

/**
 * Gate for the /admin/<token> page (server component). Open in local dev (any
 * token); in production the path segment must equal `ADMIN_TOKEN`.
 */
export function adminPageAllowed(token: string): boolean {
  if (!isProd()) return true;
  return isValidAdminToken(token);
}

/**
 * Gate for admin API routes. Open in local dev; in production requires a valid
 * token via the `x-admin-token` header or `?token=` query.
 */
export function adminApiAllowed(req: Request): boolean {
  if (!isProd()) return true;
  const headerTok = req.headers.get("x-admin-token");
  if (isValidAdminToken(headerTok)) return true;
  try {
    const queryTok = new URL(req.url).searchParams.get("token");
    return isValidAdminToken(queryTok);
  } catch {
    return false;
  }
}
