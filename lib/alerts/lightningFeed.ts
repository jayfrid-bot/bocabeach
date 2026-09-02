// The raw GLM strike feed, fetched once per alert run.
//
// `lib/sources/lightning.ts` fetches the same file but summarizes it against a
// BEACH. The at-beach engine has to summarize against each PERSON's own fix, so
// it needs the strike list itself. This module reads the feed and hands it over;
// the summarizing is still `summarizeStrikes()` from the source module, so the
// distance math has exactly one implementation.
//
// Never throws — a missing feed means no lightning alerts this run, not a failed
// run.

import type { LightningFeed } from "@/lib/sources/lightning";
import { fetchWithTimeout } from "@/lib/util";

/** Same file, same override, as lib/sources/lightning.ts. */
const FEED_URL =
  process.env.LIGHTNING_FEED_URL ??
  "https://raw.githubusercontent.com/jayfrid-bot/bocabeach/lightning-data/lightning.json";

export async function loadLightningFeed(): Promise<LightningFeed | null> {
  try {
    const res = await fetchWithTimeout(FEED_URL, {
      timeoutMs: 7000,
      next: { revalidate: 30 }, // near-real-time; the upstream loop refreshes ~1 min
    });
    if (!res.ok) return null;
    const feed = (await res.json()) as LightningFeed;
    if (!Array.isArray(feed?.strikes)) return null;
    return feed;
  } catch {
    return null;
  }
}
