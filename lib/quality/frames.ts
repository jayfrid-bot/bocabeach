// Finding the archived webcam frame behind an alert or a report
// (cam_frames, migrations/0016) and handing the owner screen a signed link to it
// (lib/camFrames/sign.ts, served by /api/cam-frames/img).
//
// A seaweed alert names its frame by SHA-256, so the archived copy is found
// exactly when the archive took that image. When the archive already held an
// earlier frame for that slot, the nearest saved frame of the same cam stands in,
// and the screen says so ("exact": false).

import type { D1Like } from "@/lib/db/d1Store";
import { sign } from "@/lib/camFrames/sign";

export interface FrameRef {
  camId: string;
  r2Key: string;
  displayAtUtc: string;
  sha256: string;
  attribution: string | null;
}

export interface FrameView {
  camId: string;
  /** Signed, 15-minute link; null when signing is not configured. */
  url: string | null;
  takenAt: string;
  /** True when this is the very image the alert was about. */
  exact: boolean;
  credit: string | null;
}

const COLS = "cam_id AS camId, r2_key AS r2Key, display_at_utc AS displayAtUtc, sha256, attribution";

/** How far from a time a stand-in frame may be. */
export const NEAR_BEFORE_MS = 45 * 60_000;
export const NEAR_AFTER_MS = 20 * 60_000;

export async function frameBySha(db: D1Like, slug: string, camId: string, sha256: string): Promise<FrameRef | null> {
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  return db
    .prepare(
      `SELECT ${COLS} FROM cam_frames WHERE slug = ?1 AND cam_id = ?2 AND sha256 = ?3 AND state = 'ready' ` +
        "ORDER BY display_at_utc DESC LIMIT 1",
    )
    .bind(slug, camId, sha256)
    .first<FrameRef>();
}

/** The ready frame of one cam closest to `atMs` inside the window, or null. */
export async function nearestFrame(db: D1Like, slug: string, camId: string, atMs: number): Promise<FrameRef | null> {
  const at = new Date(atMs).toISOString();
  return db
    .prepare(
      `SELECT ${COLS} FROM cam_frames WHERE slug = ?1 AND cam_id = ?2 AND state = 'ready' ` +
        "AND display_at_utc >= ?3 AND display_at_utc <= ?4 " +
        "ORDER BY ABS(julianday(display_at_utc) - julianday(?5)) LIMIT 1",
    )
    .bind(slug, camId, new Date(atMs - NEAR_BEFORE_MS).toISOString(), new Date(atMs + NEAR_AFTER_MS).toISOString(), at)
    .first<FrameRef>();
}

/** For each cam of the beach, its ready frame closest to `atMs` inside the window. Nearest first. */
export async function nearestFramesAllCams(db: D1Like, slug: string, atMs: number, limit = 6): Promise<FrameRef[]> {
  const r = await db
    .prepare(
      `SELECT ${COLS} FROM cam_frames WHERE slug = ?1 AND state = 'ready' ` +
        "AND display_at_utc >= ?2 AND display_at_utc <= ?3",
    )
    .bind(slug, new Date(atMs - NEAR_BEFORE_MS).toISOString(), new Date(atMs + NEAR_AFTER_MS).toISOString())
    .all<FrameRef>();
  const best = new Map<string, FrameRef>();
  const dist = (f: FrameRef) => Math.abs(Date.parse(f.displayAtUtc) - atMs);
  for (const f of r.results ?? []) {
    const cur = best.get(f.camId);
    if (!cur || dist(f) < dist(cur)) best.set(f.camId, f);
  }
  return [...best.values()].sort((a, b) => dist(a) - dist(b)).slice(0, limit);
}

/** A signed image link for an archived key, or null when signing is not set up. */
export async function signedFrameUrl(r2Key: string): Promise<string | null> {
  try {
    const { exp, sig } = await sign(r2Key);
    return `/api/cam-frames/img?k=${encodeURIComponent(r2Key)}&exp=${exp}&sig=${sig}`;
  } catch {
    return null;
  }
}

export async function toFrameView(ref: FrameRef, exact: boolean): Promise<FrameView> {
  return { camId: ref.camId, url: await signedFrameUrl(ref.r2Key), takenAt: ref.displayAtUtc, exact, credit: ref.attribution };
}
