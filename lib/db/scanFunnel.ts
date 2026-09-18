// Did the QR stickers actually lead to downloads?
//
// Three steps, each one weaker evidence than the one before it, and all three
// ours — no ad network, no third-party SDK, nothing that follows a person
// around after they have left:
//
//   1. the scan       app/sticker/route.ts   → scan_log    (a fact)
//   2. the store tap  app/get-app/route.ts   → scan_tap    (a fact)
//   3. the install    → install_attrib (a MATCH), redeemed by whichever of
//                       /api/devices or /api/push/register-native the fresh
//                       install writes to first
//
// Step 3 can only see an install that WRITES something — a home beach, a score
// profile, alerts turned on. Someone who installs the app, looks at the score
// and never touches a setting never creates a device row at all, so they are
// invisible here, the same way they are already missing from the device count.
//
// Apple tells us nothing about who installed the app, so step 3 cannot be a
// fact. What we do instead: a scan leaves a short-lived note saying "someone on
// this network just scanned", and a native device row that is born on that same
// network inside MATCH_WINDOW_MS is credited to it. Two phones on one home
// Wi-Fi therefore look like one scanner, so every number this file produces is
// reported as PROBABLE and never as a count of downloads.
//
// What we keep about the network is a salted, truncated hash of the IP and
// nothing else — never the address — and the note is deleted once the window has
// passed. That is enough to match a scan to an install for a few hours, and
// useless for anything afterwards.
//
// Every function here is fail-soft. A missing binding, a cold D1, or a write
// error must never cost someone standing on the sand their beach score: the
// caller's real job (a redirect, a device upsert) goes through regardless.

import type { D1Like } from "@/lib/db/d1Store";

/** How long after a scan an install can still be credited to it. Long enough
 *  to walk off the beach and open the App Store, short enough that it is not
 *  really "the same visit" any more. */
export const MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

/** A device row older than this is not a fresh install, so it is never
 *  credited — it is an existing phone that happens to be on the network. */
export const FRESH_INSTALL_MS = 30 * 60 * 1000;

/** The cookie `/sticker` sets so `/get-app` knows the tap came from a scan.
 *  Server-side on purpose: no client state, and it works with JS disabled. */
export const REF_COOKIE = "bd_ref";

const DEFAULT_SALT = "isitbeachday-scan-fp-v1";

/** Local calendar day at the beach — the same definition scan_log uses. */
export function localDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Only ever store a short, known-shaped tag — never free text from a URL or
 *  a cookie a visitor can set to anything they like. */
export function cleanSource(raw: string | null | undefined, fallback = "sticker"): string {
  if (!raw) return fallback;
  const s = raw.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return s || fallback;
}

/** The visitor's address as Cloudflare reports it. `x-forwarded-for` is the
 *  fallback for a non-Cloudflare runtime; its first hop is the client. */
export function clientIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first || null;
}

/**
 * The only thing we keep about a network: a salted SHA-256 of the address,
 * truncated to 16 hex characters. Not reversible, and short enough to be a
 * coarse bucket rather than an identifier. Returns null when there is no
 * address to hash, which simply means this visit cannot be matched later.
 */
export async function fingerprint(ip: string | null, salt?: string): Promise<string | null> {
  if (!ip) return null;
  try {
    const data = new TextEncoder().encode(`${salt ?? DEFAULT_SALT}:${ip}`);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  } catch {
    return null; // no Web Crypto in this runtime — matching is off, nothing breaks
  }
}

/** The salt, overridable by deployment without a code change. */
export function fpSalt(): string {
  try {
    return process.env.SCAN_FP_SALT || DEFAULT_SALT;
  } catch {
    return DEFAULT_SALT;
  }
}

/** Drop notes whose window has passed. Cheap, and it keeps the table at
 *  roughly "networks that scanned in the last six hours". */
async function sweep(db: D1Like, now: number): Promise<void> {
  await db
    .prepare(`DELETE FROM scan_claim WHERE at < ?`)
    .bind(now - MATCH_WINDOW_MS)
    .run();
}

/**
 * Step 1's side note: "someone on this network just scanned." A rescan restarts
 * the window and clears any earlier credit, so a person who scans again weeks
 * later can be credited again.
 */
export async function noteScan(
  db: D1Like | null,
  fp: string | null,
  source: string,
  now: number,
): Promise<void> {
  if (!db || !fp) return;
  try {
    await db
      .prepare(
        `INSERT INTO scan_claim (fp, source, tapped, at, claimed_at) VALUES (?, ?, 0, ?, NULL)
         ON CONFLICT(fp) DO UPDATE SET
           source = excluded.source, tapped = 0, at = excluded.at, claimed_at = NULL`,
      )
      .bind(fp, source, now)
      .run();
    await sweep(db, now);
  } catch {
    // counting is a nice-to-have
  }
}

/**
 * Step 2: they tapped "Get the app". Counts the tap, and upgrades this
 * network's note to `tapped` — the strong signal, because a tap is a person
 * heading for the App Store on purpose. A tap with no earlier scan (an ordinary
 * web visitor) leaves its own note, so web-sourced installs can be told apart
 * from sticker-sourced ones instead of silently becoming "sticker".
 */
export async function recordTap(
  db: D1Like | null,
  fp: string | null,
  source: string,
  now: number,
): Promise<void> {
  if (!db) return;
  try {
    const day = localDay(now);
    await db
      .prepare(
        `INSERT INTO scan_tap (day, source, n, first_at, last_at) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(day, source) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
      )
      .bind(day, source, now, now)
      .run();
    if (!fp) return;
    await db
      .prepare(
        `INSERT INTO scan_claim (fp, source, tapped, at, claimed_at) VALUES (?, ?, 1, ?, NULL)
         ON CONFLICT(fp) DO UPDATE SET tapped = 1, at = excluded.at, claimed_at = NULL`,
      )
      .bind(fp, source, now)
      .run();
    await sweep(db, now);
  } catch {
    // counting is a nice-to-have
  }
}

/**
 * Step 3: credit a brand-new install to a recent scan, if there is one to
 * credit it to. Three guards, all enforced in SQL so they cannot drift:
 *
 *   - the device row must be MINUTES old (`created_at`), so an existing phone
 *     that reopens the app on a scanned network is never credited;
 *   - the device must be a native install, not a web visitor — a web visit is
 *     already counted as the scan itself, and counting it again would turn
 *     every scan into a fake download;
 *   - the note must be unclaimed and inside the window; the strong (`tapped`)
 *     note wins over a bare scan, and the newest wins over an older one.
 *
 * `INSERT … ON CONFLICT(device_id) DO NOTHING` makes this idempotent: a device
 * is credited at most once however many times it posts.
 */
export async function attributeInstall(
  db: D1Like | null,
  deviceId: string,
  fp: string | null,
  now: number,
): Promise<{ source: string; kind: "tap" | "scan" } | null> {
  if (!db || !fp) return null;
  try {
    const claim = await db
      .prepare(
        `SELECT source, tapped FROM scan_claim
         WHERE fp = ? AND claimed_at IS NULL AND at >= ?
         ORDER BY tapped DESC, at DESC LIMIT 1`,
      )
      .bind(fp, now - MATCH_WINDOW_MS)
      .first<{ source: string; tapped: number }>();
    if (!claim) return null;

    const kind = claim.tapped ? "tap" : "scan";
    const wrote = await db
      .prepare(
        `INSERT INTO install_attrib (device_id, source, kind, at)
         SELECT ?1, ?2, ?3, ?4 FROM devices
         WHERE id = ?1 AND created_at >= ?5 AND platform IN ('ios','android')
         ON CONFLICT(device_id) DO NOTHING`,
      )
      .bind(deviceId, claim.source, kind, now, now - FRESH_INSTALL_MS)
      .run();
    if (!wrote.meta?.changes) return null;

    // Consume the note so a second phone on the same network cannot be
    // credited to the same scan.
    await db.prepare(`UPDATE scan_claim SET claimed_at = ? WHERE fp = ?`).bind(now, fp).run();
    return { source: claim.source, kind };
  } catch {
    return null;
  }
}

export interface FunnelReadout {
  taps: { source: string; total: number }[];
  installs: { source: string; kind: string; total: number }[];
}

/** Everything the owner console and the growth report need, in two queries. */
export async function readFunnel(db: D1Like | null): Promise<FunnelReadout> {
  const empty: FunnelReadout = { taps: [], installs: [] };
  if (!db) return empty;
  try {
    const taps =
      (
        await db
          .prepare(`SELECT source, SUM(n) AS total FROM scan_tap GROUP BY source ORDER BY total DESC`)
          .all<{ source: string; total: number }>()
      ).results ?? [];
    const installs =
      (
        await db
          .prepare(
            `SELECT source, kind, COUNT(*) AS total FROM install_attrib
             GROUP BY source, kind ORDER BY total DESC`,
          )
          .all<{ source: string; kind: string; total: number }>()
      ).results ?? [];
    return { taps, installs };
  } catch {
    return empty;
  }
}
