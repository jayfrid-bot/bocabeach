// The QR sticker's landing URL: https://isitbeachday.com/sticker
//
// It counts the scan and sends the person to the dashboard. Kept as a route
// handler rather than a next.config redirect so the scan is actually COUNTED:
// a config redirect never runs our code, and the client analytics beacon fires
// on the destination, which we cannot tell apart from ordinary home-page traffic.
//
// Counting is fail-soft in every direction — a missing binding, a cold D1, or a
// write error must never keep someone standing on the sand from reaching the
// beach score. The redirect is issued regardless.

import { NextResponse } from "next/server";
import { getD1 } from "@/lib/db/d1Store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Local calendar day at the beach, so "scans today" means what a person means. */
function localDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Only ever store a short, known-shaped tag — never free text from the URL. */
function cleanSource(raw: string | null): string {
  if (!raw) return "sticker";
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
  return s || "sticker";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = cleanSource(url.searchParams.get("s"));
  const now = Date.now();

  try {
    const db = await getD1();
    if (db) {
      await db
        .prepare(
          `INSERT INTO scan_log (day, source, n, first_at, last_at) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(day, source) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
        )
        .bind(localDay(now), source, now, now)
        .run();
    }
  } catch {
    // Counting is a nice-to-have; the redirect below is the promise we keep.
  }

  const to = new URL("/", url);
  to.searchParams.set("ref", source);
  // 307, not 308: the tag is a marketing detail we may retire, and a permanent
  // redirect would be cached in every scanner's browser forever.
  return NextResponse.redirect(to, 307);
}
