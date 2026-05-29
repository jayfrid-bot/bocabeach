import { NextResponse } from "next/server";
import { getConditions } from "@/lib/conditions";

// Cached at the edge for 5 min; individual upstream calls have their own revalidate.
export const revalidate = 300;

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  const data = await getConditions(slug);
  if (!data) {
    return NextResponse.json({ error: "Unknown location" }, { status: 404 });
  }
  return NextResponse.json(data, {
    headers: {
      "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
    },
  });
}
