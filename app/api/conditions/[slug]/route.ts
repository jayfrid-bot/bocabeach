import { NextResponse } from "next/server";
import { getConditions } from "@/lib/conditions";

// Cached at the edge for 5 min; individual upstream calls have their own revalidate.
export const revalidate = 300;

// Every caller in this repo (grepped: components/, lib/, workers/, scripts/ —
// no iOS/e2e caller hits this route directly) sends either no query string at
// all (components/ConditionsDashboard.tsx's main SWR key, components/plus/
// BeachModeCard.tsx's Live Activity poll) or exactly `?fresh=1`
// (ConditionsDashboard's staleness retry below). Nothing else is in use, so
// nothing else is allow-listed.
const ALLOWED_QUERY = new Set(["", "?fresh=1"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const url = new URL(req.url);
  // Validated BEFORE calling getConditions (Codex round 4, still blocking):
  // an unrecognized query string is rejected here, cheaply, rather than
  // reaching the conditions pipeline at all — otherwise a flood of junk
  // URLs (each a distinct edge-cache key) could force a fresh
  // `getConditions` lookup per request. Cached at the edge itself (short
  // TTL) so even a flood of the SAME bad URL doesn't repeatedly reach this
  // handler either.
  if (!ALLOWED_QUERY.has(url.search)) {
    return NextResponse.json(
      { error: "bad-query" },
      { status: 400, headers: { "Cache-Control": "public, s-maxage=300" } },
    );
  }
  const isFreshnessCheck = url.search === "?fresh=1";

  const { slug } = await params;
  const data = await getConditions(slug);
  if (!data) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }
  // budgetAborted (lib/conditions.ts, Codex round-5 #1) is an internal
  // signal for push-run consumers only — never expose it in public JSON.
  const { budgetAborted: _budgetAborted, ...publicData } = data;

  // `?fresh=1` ONLY (components/ConditionsDashboard.tsx's staleness retry,
  // Codex round 3): earlier versions used a unique `Date.now()` value with
  // `no-store`, which meant every stale-boundary visitor — or anyone who
  // just copies the pattern — forced its OWN uncached rebuild per isolate,
  // an amplification attackers could ride for free. Locking the accepted
  // value to the literal "1" (round 4: anything else is now a 400, never
  // silently treated as a plain request) means every client asking "is this
  // fresh yet" during the same 20-s window shares ONE edge cache entry
  // instead of each minting its own. `getConditions` itself never sees this
  // param — it only decides this response's own cacheability, still always
  // the same data for the same slug.
  return NextResponse.json(publicData, {
    headers: {
      "Cache-Control": isFreshnessCheck
        ? "public, s-maxage=20"
        : "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
