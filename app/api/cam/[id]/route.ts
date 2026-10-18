import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { checkAgentRateLimit } from "@/lib/agent/rateLimit";
import { readOriginal, storeOriginal } from "@/lib/camOriginalCache";
import { jpegSize } from "@/lib/jpegSize";
import {
  camSourceForId,
  pickFeedFramePath,
  pickFeedOriginalPath,
  pickFeedTimestamp,
  resolveFeedImageUrl,
} from "@/lib/camSnapshots";
import { fetchWithTimeout } from "@/lib/util";

// Live cam stills change every ~minute; Next caches the upstream fetch for 60s.
export const revalidate = 60;

/** How long a browser keeps an original it has already fetched. */
const ORIGINAL_BROWSER_MAX_AGE_SEC = 300;

/** Resolve a cam id to the concrete image URL to fetch right now (the normal still). */
async function resolveImageUrl(id: string): Promise<string | null> {
  const src = camSourceForId(id);
  if (!src) return null;
  if (src.kind === "direct") return src.url;

  // Feed: read the rotating latest.json, then resolve its most-recent frame path.
  const res = await fetchWithTimeout(`${src.base}/latest.json`, {
    timeoutMs: 6000,
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`cam ${id} feed -> ${res.status}`);
  const framePath = pickFeedFramePath(await res.json(), src.view, src.res);
  if (!framePath) throw new Error(`cam ${id} feed has no recent frame`);
  return resolveFeedImageUrl(src.base, framePath);
}

/**
 * A `direct` source's own courier (e.g. the uw-frame worker) may stamp its
 * response with the true capture time. Forward it only when present and a
 * valid ISO date, so a malformed or absent header never fabricates a time.
 */
function grabbedAtHeader(res: Response): string | undefined {
  const value = res.headers.get("X-Grabbed-At");
  if (!value) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

const ORIGINAL_HEADER = "X-Cam-Original";
/** "6000x4000": lets the viewer refuse a picture too big for the device BEFORE it downloads the body. */
const ORIGINAL_SIZE_HEADER = "X-Cam-Original-Size";

/**
 * `?res=hr&at=<ISO capture time>`: the full-size original of a feed cam's frame (1.5 to 7.3 MB,
 * 4352 to 6000 px wide, against 1200 to 1920 px for the normal "mr" still; measured 2026-10-18,
 * docs/courier-pacing.md "Picture size").
 *
 * It answers with the original (header X-Cam-Original: 1) or says plainly why not, so the
 * viewer keeps the picture it has and never downloads twice:
 *   404  this cam has no original (a courier cam, or the view has none or publishes a video)
 *   409  the feed has moved on: the original of the NEWEST frame is not the frame the viewer
 *        shows under its capture time (`at`), and a mismatched moment is worse than a soft picture
 *   the normal still, WITHOUT the header, when the per-IP limit is tripped (the viewer ignores it)
 *
 * Caching: the original is kept in the Workers Cache API under its resolved URL for 10 minutes
 * (lib/camOriginalCache.ts); the browser keeps it 5 minutes. A Cache-Control header alone does
 * not cache a Worker response, and Next's data cache refuses bodies over 2 MB.
 */
async function serveOriginal(req: Request, id: string, at: string | null): Promise<Response | null> {
  const src = camSourceForId(id);
  if (!src || src.kind !== "feed") {
    return NextResponse.json({ error: "No original for this cam" }, { status: 404 });
  }
  const feedRes = await fetchWithTimeout(`${src.base}/latest.json`, { timeoutMs: 6000, next: { revalidate: 60 } });
  if (!feedRes.ok) throw new Error(`cam ${id} feed -> ${feedRes.status}`);
  const json = await feedRes.json();

  const originalPath = pickFeedOriginalPath(json, src.view);
  if (!originalPath) {
    return NextResponse.json({ error: "No original for this cam" }, { status: 404 });
  }
  const shownAt = at ? Date.parse(at) : NaN;
  const latestAt = Date.parse(pickFeedTimestamp(json, src.view) ?? "");
  if (!Number.isFinite(shownAt) || !Number.isFinite(latestAt) || shownAt !== latestAt) {
    return NextResponse.json({ error: "The feed has a newer frame" }, { status: 409 });
  }
  const url = resolveFeedImageUrl(src.base, originalPath);

  const headers = (contentType: string, size: string | null) => ({
    "Content-Type": contentType,
    "Cache-Control": `public, max-age=${ORIGINAL_BROWSER_MAX_AGE_SEC}`,
    [ORIGINAL_HEADER]: "1",
    ...(size ? { [ORIGINAL_SIZE_HEADER]: size } : {}),
  });

  const hit = await readOriginal(url);
  if (hit?.body) {
    return new NextResponse(hit.body, {
      status: 200,
      headers: headers(hit.headers.get("content-type") ?? "image/jpeg", hit.headers.get(ORIGINAL_SIZE_HEADER)),
    });
  }

  // A miss goes to the county server: this is what the per-IP limit protects.
  if ((await checkAgentRateLimit(req, "cam")).limited) return null; // the caller serves the normal still

  const res = await fetchWithTimeout(url, { timeoutMs: 20000, cache: "no-store" });
  if (!res.ok) throw new Error(`cam ${id} original -> ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error(`cam ${id} original returned ${contentType}`);
  const bytes = await res.arrayBuffer();
  const dims = jpegSize(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 262144)));
  const size = dims ? `${dims.width}x${dims.height}` : null;
  const stored = storeOriginal(url, bytes, contentType, size);
  try {
    (await getCloudflareContext({ async: true })).ctx.waitUntil(stored);
  } catch {
    /* no Workers context (Node, tests): the store promise just runs */
  }
  return new NextResponse(bytes, { status: 200, headers: headers(contentType, size) });
}

/**
 * Proxy a configured cam's live snapshot JPEG. The browser only ever sees a
 * same-origin response; the upstream hop is https where the host supports it.
 * The guarantee here is same-origin, not https end-to-end.
 * Only ids present in the CAM_SOURCES allowlist are fetchable (no SSRF), and
 * we re-encode nothing — just stream the upstream image bytes through.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const query = new URL(req.url).searchParams;

  try {
    if (query.get("res") === "hr") {
      if (!camSourceForId(id)) return NextResponse.json({ error: "Unknown cam" }, { status: 404 });
      const original = await serveOriginal(req, id, query.get("at"));
      if (original) return original;
      // Over the limit: fall through and serve the normal still (no X-Cam-Original header).
    }

    const src = camSourceForId(id);
    const upstream = await resolveImageUrl(id);
    if (!upstream) {
      return NextResponse.json({ error: "Unknown cam" }, { status: 404 });
    }

    const res = await fetchWithTimeout(upstream, {
      timeoutMs: 8000,
      next: { revalidate: 60 },
    });
    if (!res.ok) throw new Error(`cam ${id} upstream -> ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      throw new Error(`cam ${id} upstream returned ${contentType}`);
    }

    // Forward the courier's own capture-time header for a `direct` source
    // (e.g. the uw-frame worker) so the client can show an honest capture
    // time instead of "unknown".
    const grabbedAt = src?.kind === "direct" ? grabbedAtHeader(res) : undefined;

    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
        ...(grabbedAt ? { "X-Grabbed-At": grabbedAt } : {}),
      },
    });
  } catch (e) {
    // Keep the detail server-side; don't leak upstream URLs/errors to the client.
    console.error(`cam ${id} proxy failed:`, e);
    return NextResponse.json(
      { error: "Upstream cam fetch failed" },
      { status: 502 },
    );
  }
}
