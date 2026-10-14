// Headers every owner response carries: private, uncached, and never framed. A page or an
// API answer from the owner area must not be embeddable by another site (a framed owner
// screen could be clicked through without the owner seeing what was tapped).

export const OWNER_HEADERS: Record<string, string> = {
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
};

export function ownerJson(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(data, { status, headers: { ...OWNER_HEADERS, ...extra } });
}

export function ownerFail(error: string, status: number, extra: Record<string, string> = {}): Response {
  return ownerJson({ ok: false, error }, status, extra);
}
