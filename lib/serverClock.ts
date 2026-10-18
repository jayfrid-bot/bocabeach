// The server's clock, as seen from the page.
//
// How old the data on screen is decides two refreshes (lib/conditionsFreshness.ts): the
// data call on load (over 3 minutes) and the background retry (over 10 minutes). The
// snapshot time is the server's clock. Comparing it with the phone's clock (Date.now())
// goes wrong on a phone whose clock is off: 5 minutes slow, and data 7 minutes old looks
// 2 minutes old and is never refreshed. So the page keeps the offset between the two
// clocks and measures age on the server's clock.
//
// Where the server time comes from:
//   1. The page itself. The edge cache (lib/edgeCache.ts) adds `Server-Timing: ibd-now;desc=<ms>`
//      to every HTML answer, at the moment it answers (also for a stored copy). Ignored when
//      the service worker answered from its saved copy (that copy also carries `ibd-sw`),
//      because then the value is as old as the copy.
//   2. Every data answer that came from the network: its `Date` header (1 s steps).
//   3. The last offset this browser learned (localStorage, for at most a day), for a page
//      from the worker.
// An offset over a day either way is a bad reading and is ignored.
// With none of these the offset is 0: the phone's own clock, as before.

export const SERVER_NOW_TIMING = "ibd-now";
const STORE_KEY = "ibd:clock-offset";
/** A learned offset is trusted for this long (a phone's clock gets corrected). */
export const OFFSET_MAX_AGE_MS = 24 * 3600_000;
/** An offset bigger than this is not a clock that is off: it is a bad reading. Ignored. */
export const MAX_OFFSET_MS = 24 * 3600_000;

/** A usable offset: a finite number no bigger than MAX_OFFSET_MS either way. */
export function plausibleOffset(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= MAX_OFFSET_MS;
}

type TimingEntry = { name: string; description?: string };

/** Server time (ms) from a navigation's Server-Timing, or null (none, or the worker's saved copy). */
export function serverNowFromTiming(entries: ReadonlyArray<TimingEntry>): number | null {
  if (entries.some((e) => e.name === "ibd-sw")) return null;
  for (const e of entries) {
    if (e.name !== SERVER_NOW_TIMING) continue;
    const n = Number(e.description);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** server − device, from a `Date` header received at `receivedAt` (device ms). Null when unusable. */
export function offsetFromDateHeader(date: string | null | undefined, receivedAt: number): number | null {
  if (!date) return null;
  const ms = Date.parse(date);
  if (!Number.isFinite(ms)) return null;
  return ms + 500 - receivedAt; // the header has whole seconds: take the middle of the second
}

/** Parse a stored offset; null when missing, malformed or too old. */
export function parseStoredOffset(raw: string | null, now: number): number | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { offset?: unknown; at?: unknown };
    if (typeof j.offset !== "number" || typeof j.at !== "number" || !plausibleOffset(j.offset)) return null;
    if (now - j.at > OFFSET_MAX_AGE_MS || j.at > now + OFFSET_MAX_AGE_MS) return null;
    return j.offset;
  } catch {
    return null;
  }
}

let offset: number | null = null;
let initialised = false;

/** Record a measured offset (server − device) for this page and later ones. */
export function learnOffset(value: number | null, deviceNow = Date.now()): void {
  if (!plausibleOffset(value)) return; // over a day off: a bad reading, not a clock
  offset = value;
  initialised = true;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ offset: value, at: deviceNow }));
  } catch {
    /* private mode: this page still uses it */
  }
}

/** Learn from a data answer, unless it is the worker's saved copy (its Date is old). */
export function learnFromResponse(res: { headers: { get(name: string): string | null } }, receivedAt = Date.now()): void {
  if (res.headers.get("x-ibd-cached-at")) return;
  learnOffset(offsetFromDateHeader(res.headers.get("date"), receivedAt), receivedAt);
}

function init(): void {
  if (initialised || typeof window === "undefined") return;
  initialised = true;
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const fromPage = nav ? serverNowFromTiming(nav.serverTiming ?? []) : null;
    if (fromPage != null && nav) {
      // The edge stamped the time it started answering; responseStart is when it arrived.
      learnOffset(fromPage - (performance.timeOrigin + nav.responseStart));
      return;
    }
  } catch {
    /* no Performance API */
  }
  try {
    offset = parseStoredOffset(localStorage.getItem(STORE_KEY), Date.now());
  } catch {
    offset = null;
  }
}

/** Now, on the server's clock as best known (the device clock when nothing is known). */
export function serverNow(deviceNow = Date.now()): number {
  init();
  return deviceNow + (offset ?? 0);
}

/** For tests. */
export function _resetServerClockForTests(): void {
  offset = null;
  initialised = false;
}
