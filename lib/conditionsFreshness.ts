// Shared between lib/conditions.ts (the server pipeline) and
// components/ConditionsDashboard.tsx (a "use client" component) — kept in
// its own dependency-free module so importing it from the client bundle
// never drags in the ~20 lib/sources/*.ts fetch adapters lib/conditions.ts
// itself pulls in.

/**
 * How stale a displayed snapshot may be before the client asks for a fresh
 * one. `unstable_cache`'s 120-s revalidate is stale-while-revalidate under
 * OpenNext, so the FIRST visitor to a low-traffic beach after the window
 * lapses can be served (and then keep displaying) a snapshot that is
 * 15–85 min old (measured live: santa-monica at 85 min, 31/38 beaches
 * stale) — nobody revalidates it until someone asks, and on a quiet beach
 * that can be a long time.
 */
export const CONDITIONS_MAX_STALE_MS = 10 * 60 * 1000;

/** At most 2 background retries (Codex round 2) — a beach whose pipeline is
 *  genuinely stuck must not turn into a client polling loop. */
export const FRESHNESS_MAX_ATTEMPTS = 2;

/**
 * Pure decision for ConditionsDashboard's post-mount staleness retry: worth
 * another background `?fresh=` refetch, or not? `attempts` is how many
 * refetches have already been TRIED (successful or not) — capped so a beach
 * whose pipeline is genuinely stuck doesn't turn into an unbounded client
 * polling loop.
 */
export function shouldRefetchForFreshness(generatedAtIso: string, nowMs: number, attempts: number): boolean {
  if (attempts >= FRESHNESS_MAX_ATTEMPTS) return false;
  const generatedMs = Date.parse(generatedAtIso);
  if (!Number.isFinite(generatedMs)) return false;
  return nowMs - generatedMs > CONDITIONS_MAX_STALE_MS;
}

/**
 * A snapshot the server rendered this recently is as good as anything the API
 * would answer with, so the page does not ask again the moment it loads. The
 * HTML is built from the same 120-s cache the API reads, while the API's own
 * edge copy may be up to 5 minutes old: that mount-time request used to cost a
 * second download of the whole snapshot on every visit and could even replace
 * fresh numbers with older ones. Older than this, the page asks as it always did.
 */
export const MOUNT_REVALIDATE_AFTER_MS = 3 * 60 * 1000;

/** Pure decision for ConditionsDashboard: refetch right after mounting, or trust the HTML? */
export function shouldRevalidateOnMount(generatedAtIso: string, nowMs: number): boolean {
  const generatedMs = Date.parse(generatedAtIso);
  if (!Number.isFinite(generatedMs)) return true; // cannot tell how old it is: ask
  return nowMs - generatedMs > MOUNT_REVALIDATE_AFTER_MS;
}
