import { NextResponse } from "next/server";
import {
  camSourceForId,
  pickFeedFramePath,
  resolveFeedImageUrl,
} from "@/lib/camSnapshots";
import { fetchWithTimeout } from "@/lib/util";

// Live cam stills change every ~minute; cache at the edge for 60s.
export const revalidate = 60;

/** The full-size original of a feed frame is a camera JPEG ("o181432k.jpg"). Some views
 *  publish a video there instead ("o181404a.mp4"); those never get served as the picture. */
const JPEG_PATH = /\.jpe?g$/i;

/**
 * Resolve a cam id to the concrete image URL to fetch right now.
 *
 * `wantOriginal` (the `?res=hr` query) asks a feed cam for its full-size original: the
 * latest.json "hr" frame, 1.5 to 7.3 MB and 4352 to 6000 px wide against the 1200 to 1920 px
 * "mr" frame (measured 2026-10-18, docs/research/2026-10-18-cam-resolution/REPORT.md).
 * A direct cam has no original: its frame is the one the courier grabbed.
 */
async function resolveImageUrl(
  id: string,
  wantOriginal = false,
): Promise<{ url: string; original: boolean } | null> {
  const src = camSourceForId(id);
  if (!src) return null;
  if (src.kind === "direct") return { url: src.url, original: false };

  // Feed: read the rotating latest.json, then resolve its most-recent frame path.
  const res = await fetchWithTimeout(`${src.base}/latest.json`, {
    timeoutMs: 6000,
    next: { revalidate: 60 },
  });
  if (!res.ok) throw new Error(`cam ${id} feed -> ${res.status}`);
  const json = await res.json();
  if (wantOriginal) {
    const originalPath = pickFeedFramePath(json, src.view, "hr");
    if (originalPath && JPEG_PATH.test(originalPath)) {
      return { url: resolveFeedImageUrl(src.base, originalPath), original: true };
    }
    // No usable original (missing, or a video): serve the normal frame instead.
  }
  const framePath = pickFeedFramePath(json, src.view, src.res);
  if (!framePath) throw new Error(`cam ${id} feed has no recent frame`);
  return { url: resolveFeedImageUrl(src.base, framePath), original: false };
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
  const wantOriginal = new URL(req.url).searchParams.get("res") === "hr";

  try {
    const src = camSourceForId(id);
    const resolved = await resolveImageUrl(id, wantOriginal);
    if (!resolved) {
      return NextResponse.json({ error: "Unknown cam" }, { status: 404 });
    }
    const { url: upstream, original } = resolved;

    // An original is megabytes. Next's data cache refuses bodies over 2 MB, so it is not
    // cached there; the response header below lets the edge cache it for a minute instead.
    const res = await fetchWithTimeout(
      upstream,
      original ? { timeoutMs: 20000, cache: "no-store" } : { timeoutMs: 8000, next: { revalidate: 60 } },
    );
    if (!res.ok) throw new Error(`cam ${id} upstream -> ${res.status}`);

    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    if (!contentType.startsWith("image/")) {
      throw new Error(`cam ${id} upstream returned ${contentType}`);
    }

    // Forward the courier's own capture-time header for a `direct` source
    // (e.g. the uw-frame worker) so the client can show an honest capture
    // time instead of "unknown".
    const grabbedAt = src?.kind === "direct" ? grabbedAtHeader(res) : undefined;

    const body = original ? res.body : await res.arrayBuffer();
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
