import { NextResponse } from "next/server";
import { snapshotUrlForId } from "@/lib/camSnapshots";
import { fetchWithTimeout } from "@/lib/util";

// Live cam stills change every ~minute; cache at the edge for 60s.
export const revalidate = 60;

/**
 * Proxy a configured cam's live snapshot JPEG, same-origin over https.
 * Only ids present in the CAM_SNAPSHOTS allowlist are fetchable (no SSRF), and
 * we re-encode nothing — just stream the upstream image bytes through.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const upstream = snapshotUrlForId(id);
  if (!upstream) {
    return NextResponse.json({ error: "Unknown cam" }, { status: 404 });
  }

  try {
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
    return NextResponse.json({ error: String(e) }, { status: 502 });
  }
}
