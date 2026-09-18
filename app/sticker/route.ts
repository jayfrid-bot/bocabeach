// The QR sticker's landing URL: https://isitbeachday.com/sticker
//
// It counts the scan and sends the person to the dashboard. Kept as a route
// handler rather than a next.config redirect so the scan is actually COUNTED:
// a config redirect never runs our code, and the client analytics beacon fires
// on the destination, which we cannot tell apart from ordinary home-page traffic.
//
// It also leaves two traces so the funnel can be followed past the scan (see
// lib/db/scanFunnel.ts): a cookie, so a later tap on "Get the app" is known to
// have come from a sticker, and a short-lived, hashed network note, so a native
// install that appears minutes later can be credited to this scan.
//
// Counting is fail-soft in every direction — a missing binding, a cold D1, or a
// write error must never keep someone standing on the sand from reaching the
// beach score. The redirect is issued regardless.

import { NextResponse } from "next/server";
import { getD1 } from "@/lib/db/d1Store";
import {
  MATCH_WINDOW_MS,
  REF_COOKIE,
  cleanSource,
  clientIp,
  fingerprint,
  fpSalt,
  localDay,
  noteScan,
} from "@/lib/db/scanFunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Link-preview crawlers and unfurlers (iMessage, Slack, WhatsApp, social
 *  bots, search crawlers) fetch the URL to build a preview. They are not a
 *  person scanning a sticker, so they must not inflate the count — but they
 *  still get redirected like anyone else. A missing UA is treated as a bot. */
function looksLikeBot(ua: string | null): boolean {
  if (!ua) return true;
  return /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slackbot|embedly|quora link|redditbot|applebot|bingbot|googlebot|yandex|petalbot|headless|python-requests|curl|wget|axios|node-fetch|go-http/i.test(
    ua,
  );
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const source = cleanSource(url.searchParams.get("s"));
  const now = Date.now();
  const isBot = looksLikeBot(req.headers.get("user-agent"));

  try {
    const db = await getD1();
    if (db && !isBot) {
      await db
        .prepare(
          `INSERT INTO scan_log (day, source, n, first_at, last_at) VALUES (?, ?, 1, ?, ?)
           ON CONFLICT(day, source) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
        )
        .bind(localDay(now), source, now, now)
        .run();
      await noteScan(db, await fingerprint(clientIp(req), fpSalt()), source, now);
    }
  } catch {
    // Counting is a nice-to-have; the redirect below is the promise we keep.
  }

  const to = new URL("/", url);
  to.searchParams.set("ref", source);
  // 307, not 308: the tag is a marketing detail we may retire, and a permanent
  // redirect would be cached in every scanner's browser forever.
  const res = NextResponse.redirect(to, 307);
  if (!isBot) {
    // Lives exactly as long as an install can still be credited to this scan.
    // Not a tracker: one short tag, our own site only, no personal data.
    res.cookies.set(REF_COOKIE, source, {
      maxAge: Math.floor(MATCH_WINDOW_MS / 1000),
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      secure: true,
    });
  }
  return res;
}
