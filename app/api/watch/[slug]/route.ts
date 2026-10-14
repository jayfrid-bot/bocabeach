// GET /api/watch/<slug> — the small, ready-to-show answer the Apple Watch app
// reads (lib/watchView.ts). The watch used to download the whole conditions
// payload (~160 KB) and re-decide safety on its own; now the website's logic
// decides and the watch only draws. Cached at the edge like the conditions
// route; nothing personal goes in or out.

import { NextResponse } from "next/server";
import { getConditions, stripInternalSnapshotFields } from "@/lib/conditions";
import { buildWatchView } from "@/lib/watchView";

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
  const data = await getConditions(slug);
  if (!data) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }
  const { budgetAborted, ...publicData } = stripInternalSnapshotFields(data);

  return NextResponse.json(buildWatchView(publicData as typeof data), {
    headers: {
      // A build that ran out of upstream budget is incomplete: let it expire fast.
      "Cache-Control": budgetAborted
        ? "public, s-maxage=20"
        : "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
