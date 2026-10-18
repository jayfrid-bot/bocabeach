import { NextResponse } from "next/server";
import { getConditions } from "@/lib/conditions";
import { toWire } from "@/lib/clientConditions";

// The page's own copy of /api/conditions/<slug>: same data, a third of the bytes
// (lib/clientConditions.ts says how). /api/conditions/<slug> itself is untouched —
// it is a documented public endpoint, so its shape stays exactly as it was.
//
// Caching mirrors that route on purpose: the same 5-minute edge entry, the same
// literal `?fresh=1` for the staleness retry, the same rejection of every other
// query string before the conditions pipeline is reached.
export const revalidate = 300;

const ALLOWED_QUERY = new Set(["", "?fresh=1"]);

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const url = new URL(req.url);
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
  // toWire drops budgetAborted and skyAlertCandidates (server-only) along with
  // the fields no client code reads.
  return NextResponse.json(toWire(data), {
    headers: {
      "Cache-Control": isFreshnessCheck
        ? "public, s-maxage=20"
        : "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
