// Daily active users. See migrations/0009_app_opens.sql for why this exists
// and what it keeps.
//
// Counting is fail-soft: a missing binding or a write error must never break
// the page that asked, so every path here swallows its errors.

import type { D1Like } from "@/lib/db/d1Store";
import { localDay } from "@/lib/db/scanFunnel";

export const OPEN_PLATFORMS = ["ios", "android", "web"] as const;
export type OpenPlatform = (typeof OPEN_PLATFORMS)[number];

const SALT = "isitbeachday-open-v1";

export function isOpenPlatform(v: unknown): v is OpenPlatform {
  return typeof v === "string" && (OPEN_PLATFORMS as readonly string[]).includes(v);
}

/** Salted, truncated SHA-256 of the device id: stable per device, one-way,
 *  and different from every other hash we keep, so it joins to nothing. */
export async function hashOpenId(deviceId: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${SALT}:${deviceId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Record that this device opened the app today. A second call on the same
 *  day changes nothing. Returns true when the row was written. */
export async function recordOpen(
  db: D1Like | null,
  deviceId: string,
  platform: OpenPlatform,
  now: number,
): Promise<boolean> {
  if (!db) return false;
  try {
    const res = await db
      .prepare(
        `INSERT INTO app_opens (day, id_hash, platform, first_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(day, id_hash) DO NOTHING`,
      )
      .bind(localDay(now), await hashOpenId(deviceId), platform, now)
      .run();
    return (res.meta?.changes ?? 0) > 0;
  } catch {
    return false; // counting is a nice-to-have
  }
}
