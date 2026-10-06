// Continuous cam archive (migrations/0006 `cam_observations` + 0014
// `cam_reads`). The vision job publishes one feed per beach —
// cam_seaweed.<slug>.json — whose rolling `history[]` carries every cam read
// (a roll-up across that beach's cams) and whose `latest` / `morning` groups
// carry the PER-CAM reads of the newest capture. The hourly archiver
// (app/api/history/archive/route.ts) calls `archiveCamObservations` after the
// beach_hourly write so the table stays current instead of stopping at the
// one-shot scripts/backfill_cam_history.mjs run.
//
// Never creates beach_hourly rows or fabricates a score from cam data alone.
// Idempotent: every insert is INSERT OR IGNORE on the table's primary key.
// Best-effort: the caller wraps this in try/catch, and a feed that is down,
// 404, or malformed simply archives nothing this pass.

import visionCams from "@/config/vision-cams.json";
import { camFeedUrlCandidates } from "@/lib/sources/camFeed";
import { fetchWithTimeout } from "@/lib/util";
import type { CamObservationRow, CamReadRow } from "@/lib/history/types";
import type { DeviceStore } from "@/lib/db/store";
import { camReadRow, parseCapturedAtUtc, rowFromHistoryEntry } from "@/lib/history/camObservationRow.mjs";

export { parseCapturedAtUtc, rowFromHistoryEntry, camReadRow };

/** Most history rows inserted per beach per pass. The feed can hold ~1,200
 *  reads, so a first catch-up is spread over a few passes (oldest first, so
 *  nothing is ever skipped) instead of blowing the Worker's per-request
 *  subrequest/CPU budget. Steady state is ~1-6 new reads per hour. */
export const MAX_CAM_ROWS_PER_PASS = 200;

/** How far back before the newest stored read an entry is still checked for a
 *  hole (a pass that failed mid-write) — beyond that only newer entries count. */
export const REPAIR_WINDOW_MS = 72 * 3_600_000;

/** Beaches the vision job covers (config/vision-cams.json) — the only ones
 *  that publish a cam feed. */
export function hasVisionCamFeed(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(visionCams, slug);
}

/** The slice of a published cam feed this module reads. */
export interface CamFeedDoc {
  uw?: { pct?: number | null; note?: string | null; capturedAtLocal?: string } | null;
  latest?: { capturedAtLocal?: string; cams?: unknown[] } | null;
  morning?: { capturedAtLocal?: string; cams?: unknown[] } | null;
  history?: unknown[];
}

/** Fetch a beach's cam feed using the SAME URL resolver the live sources use
 *  (own per-beach file, then Boca's legacy file on a 404). Null when none is
 *  published or the body is not an object; throws on a network/HTTP failure
 *  (the caller isolates it). */
export async function fetchCamFeed(slug: string): Promise<CamFeedDoc | null> {
  let res: Response | undefined;
  for (const url of camFeedUrlCandidates(slug)) {
    res = await fetchWithTimeout(url, { timeoutMs: 7000 });
    if (res.status !== 404) break;
  }
  if (!res || res.status === 404) return null;
  if (!res.ok) throw new Error(`cam feed -> ${res.status}`);
  const doc = (await res.json()) as unknown;
  return doc && typeof doc === "object" ? (doc as CamFeedDoc) : null;
}

/**
 * The `cam_observations` rows to insert, given a feed and what is already
 * stored: every history entry NEWER than the newest stored read, plus any
 * entry inside the repair window that is not in `storedRecent`. Oldest first,
 * de-duplicated by capture time, capped at `max`. Pure.
 */
export function newObservationRows(
  slug: string,
  feed: CamFeedDoc,
  stored: { latestUtc: string | null; recentUtcs: ReadonlySet<string> },
  max: number = MAX_CAM_ROWS_PER_PASS,
): CamObservationRow[] {
  const history = Array.isArray(feed.history) ? feed.history : [];
  const latestMs = stored.latestUtc ? Date.parse(stored.latestUtc) : -Infinity;
  const repairFloor = latestMs - REPAIR_WINDOW_MS;
  const byUtc = new Map<string, CamObservationRow>();
  for (const entry of history) {
    const row = rowFromHistoryEntry(slug, entry, feed) as CamObservationRow | null;
    if (!row || byUtc.has(row.captured_at_utc)) continue;
    const ms = Date.parse(row.captured_at_utc);
    const isNew = ms > latestMs;
    const isHole = !isNew && ms >= repairFloor && !stored.recentUtcs.has(row.captured_at_utc);
    if (isNew || isHole) byUtc.set(row.captured_at_utc, row);
  }
  return [...byUtc.values()]
    .sort((a, b) => (a.captured_at_utc < b.captured_at_utc ? -1 : a.captured_at_utc > b.captured_at_utc ? 1 : 0))
    .slice(0, max);
}

/** Per-cam rows from the feed's `morning` and `latest` groups (de-duplicated
 *  on the primary key — the two are the same capture on some ticks). Pure. */
export function camReadRowsFromFeed(slug: string, feed: CamFeedDoc): CamReadRow[] {
  const out = new Map<string, CamReadRow>();
  for (const group of [feed.morning, feed.latest]) {
    for (const cam of group?.cams ?? []) {
      const row = camReadRow(slug, group, cam) as CamReadRow | null;
      if (row) out.set(`${row.captured_at_utc}|${row.cam_id}`, row);
    }
  }
  return [...out.values()];
}

export interface CamArchiveResult {
  observations: number;
  reads: number;
}

/**
 * Archive one beach's cam feed. `feedFetcher` is injectable for tests. Returns
 * how many rows were newly written; a missing feed archives nothing.
 */
export async function archiveCamObservations(
  store: Pick<
    DeviceStore,
    "latestCamObservationUtc" | "camObservationUtcsSince" | "insertCamObservations" | "insertCamReads"
  >,
  slug: string,
  feedFetcher: (slug: string) => Promise<CamFeedDoc | null> = fetchCamFeed,
): Promise<CamArchiveResult> {
  const feed = await feedFetcher(slug);
  if (!feed) return { observations: 0, reads: 0 };

  const latestUtc = await store.latestCamObservationUtc(slug);
  const recentUtcs = new Set(
    latestUtc
      ? await store.camObservationUtcsSince(slug, new Date(Date.parse(latestUtc) - REPAIR_WINDOW_MS).toISOString())
      : [],
  );
  const rows = newObservationRows(slug, feed, { latestUtc, recentUtcs });
  const reads = camReadRowsFromFeed(slug, feed);

  const obs = rows.length ? await store.insertCamObservations(rows) : { written: 0 };
  const rd = reads.length ? await store.insertCamReads(reads) : { written: 0 };
  return { observations: obs.written, reads: rd.written };
}
