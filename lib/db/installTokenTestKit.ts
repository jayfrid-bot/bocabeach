// Test helper (not imported by app code): wraps a route handler so a test that
// calls it many times for one device behaves like the real app. The app keeps
// the install token the first response hands back and sends it as
// `x-install-token` from then on; this does the same per deviceId, so tests of
// unrelated behaviour (prefs, profile, push registration) don't each have to
// thread a token by hand. Tests about the token itself call the raw handler.

type Handler = (req: Request) => Promise<Response>;

export interface TokenCarrier {
  /** The wrapped handler. */
  call: Handler;
  /** Forget every remembered token (call from `beforeEach`). */
  reset(): void;
}

/** Pass the same jar to several carriers when one phone talks to several
 *  routes (register, then unregister). */
export function tokenCarrier(handler: Handler, tokens: Map<string, string> = new Map()): TokenCarrier {
  const call: Handler = async (req) => {
    const text = await req.text();
    let deviceId: string | null = null;
    try {
      const parsed = JSON.parse(text) as { deviceId?: unknown };
      if (typeof parsed?.deviceId === "string") deviceId = parsed.deviceId;
    } catch {
      /* not JSON — pass through untouched */
    }
    const headers = new Headers(req.headers);
    const known = deviceId ? tokens.get(deviceId) : undefined;
    if (known && !headers.has("x-install-token")) headers.set("x-install-token", known);
    const res = await handler(new Request(req.url, { method: req.method, headers, body: text || undefined }));
    try {
      const minted = ((await res.clone().json()) as { installToken?: unknown } | null)?.installToken;
      if (deviceId && typeof minted === "string") tokens.set(deviceId, minted);
    } catch {
      /* no JSON body */
    }
    return res;
  };
  return { call, reset: () => tokens.clear() };
}
