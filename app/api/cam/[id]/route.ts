import { NextResponse } from "next/server";
import {
  camSourceForId,
  pickFeedFramePath,
  resolveFeedImageUrl,
} from "@/lib/camSnapshots";
import { fetchWithTimeout } from "@/lib/util";

// Live cam stills change every ~minute; cache at the edge for 60s.
export const revalidate = 60;

/** Resolve a cam id to the concrete image URL to fetch right now. */
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
 * Proxy a configured cam's live snapshot JPEG. The browser only ever sees a
 * same-origin response; the upstream hop is https where the host supports it,
 * but a couple of cam hosts (bocasurfcam.com, lakebocacam.com) are http-only,
 * so the guarantee here is same-origin, not https end-to-end.
 * Only ids present in the CAM_SOURCES allowlist are fetchable (no SSRF), and
 * we re-encode nothing — just stream the upstream image bytes through.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
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

    const body = await res.arrayBuffer();
    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
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
