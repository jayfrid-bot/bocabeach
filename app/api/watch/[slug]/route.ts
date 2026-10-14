// GET /api/watch/<slug> — the small, ready-to-show answer the Apple Watch app
// reads (lib/watchView.ts). The watch used to download the whole conditions
// payload (~160 KB) and re-decide safety on its own; now the website's logic
// decides and the watch only draws. Nothing personal goes in or out.
//
// Cache: s-maxage = min(60, seconds until the payload's own validUntil), 0 left =
// no-store, and NO stale-while-revalidate. This view is computed
// against the clock (alerts starting and ending, the hourly rip model, the best
// window), so unlike the raw conditions it must not be served minutes late; the
// payload's own `validUntil` tells the watch when it stops being current.

import { NextResponse } from "next/server";
import { getConditions, stripInternalSnapshotFields } from "@/lib/conditions";
import { buildWatchView, cacheControlFor } from "@/lib/watchView";

export const revalidate = 300;

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  // No query string is meaningful here; reject junk before it can mint cache keys.
  if (new URL(req.url).search !== "") {
    return NextResponse.json(
      { error: "bad-query" },
      { status: 400, headers: { "Cache-Control": "public, s-maxage=300" } },
    );
  }

  const { slug } = await params;
  const notFound = () =>
    NextResponse.json({ error: "Unknown location" }, { status: 404, headers: { "Cache-Control": "public, s-maxage=300" } });
  // Syntax first, so a junk path never reaches the pipeline (and the 404 is cached at the edge).
  if (slug.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return notFound();
  const data = await getConditions(slug);
  if (!data) return notFound();
  const { budgetAborted, ...publicData } = stripInternalSnapshotFields(data);

  // A build that ran out of upstream budget is deliberately incomplete. Never
  // hand it out as an answer: an error the watch rejects without touching its
  // cache, and nothing for the edge to keep.
  if (budgetAborted) {
    return NextResponse.json(
      { error: "incomplete" },
      { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
    );
  }

  const view = buildWatchView(publicData as typeof data);
  // The edge may keep it no longer than the view stays valid, and never over a minute.
  // Already expired (a snapshot older than 15 minutes): nothing to keep.
  const secondsValid = Math.floor((Date.parse(view.validUntil) - Date.parse(view.capturedAt)) / 1000);
  return NextResponse.json(view, {
    headers: { "Cache-Control": cacheControlFor(secondsValid) },
  });
}
