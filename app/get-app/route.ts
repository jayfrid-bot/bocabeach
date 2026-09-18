// /get-app — the web app's "Get the app" hop.
//
// It counts the tap and sends the person to the App Store. Two reasons it is a
// route and not a plain link to Apple:
//
//   - A tap is the last thing we can actually observe. Apple tells us how many
//     people installed, never which of them had just scanned a sticker, so
//     "scans → taps" is the real, measured part of the funnel and the install
//     match hangs off it (lib/db/scanFunnel.ts).
//   - It tags the tap with where the visit came from. `/sticker` left a cookie,
//     so a tap from a scanned session counts as "sticker" and every other tap
//     counts as "web", instead of both landing in one undifferentiated number.
//
// Fail-soft like the sticker route: whatever happens to the counting, the
// redirect to the App Store is the promise we keep.

import { NextResponse } from "next/server";
import { APP_STORE_URL } from "@/lib/appStore";
import { getD1 } from "@/lib/db/d1Store";
import {
  REF_COOKIE,
  cleanSource,
  clientIp,
  fingerprint,
  fpSalt,
  recordTap,
} from "@/lib/db/scanFunnel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Crawlers prefetch links. A prefetched link is not a person deciding to
 *  install, so it must not inflate the tap count. */
function looksLikeBot(ua: string | null): boolean {
  if (!ua) return true;
  return /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|discord|slackbot|embedly|quora link|redditbot|applebot|bingbot|googlebot|yandex|petalbot|headless|python-requests|curl|wget|axios|node-fetch|go-http/i.test(
    ua,
  );
}

/**
 * Apple's own campaign tagging, as a cross-check on our numbers in App Store
 * Connect → App Analytics. It needs the account's provider token, which is not
 * in the repo; without it the tokens are ignored by Apple, so we leave the URL
 * clean rather than tack on parameters that do nothing.
 */
function storeUrl(source: string): string {
  const pt = process.env.ASC_PROVIDER_TOKEN;
  if (!pt) return APP_STORE_URL;
  const u = new URL(APP_STORE_URL);
  u.searchParams.set("pt", pt);
  u.searchParams.set("ct", source);
  u.searchParams.set("mt", "8");
  return u.toString();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const now = Date.now();
  const isBot = looksLikeBot(req.headers.get("user-agent"));
  // The cookie the sticker route set wins; `?s=` lets a one-off link (a flyer,
  // an email) name itself. Anything else is ordinary web traffic.
  const cookieRef = req.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${REF_COOKIE}=`))
    ?.slice(REF_COOKIE.length + 1);
  const source = cleanSource(cookieRef || url.searchParams.get("s"), "web");

  if (!isBot) {
    try {
      const db = await getD1();
      await recordTap(db, await fingerprint(clientIp(req), fpSalt()), source, now);
    } catch {
      // counting is a nice-to-have
    }
  }

  return NextResponse.redirect(storeUrl(source), 307);
}
