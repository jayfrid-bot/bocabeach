"use client";

// The owner's hidden way into /admin/review from INSIDE the iPhone app, which has no address bar and
// no universal links: tap the "Support ID" line 5 times within 3 seconds. Nothing changes on screen for
// anyone else; the line looks and behaves as before. The review page itself is a closed shell for a
// phone that is not enrolled (it shows only an "Owner code" box).

import { useCallback, useRef } from "react";

export const OWNER_ENTRY_TAPS = 5;
export const OWNER_ENTRY_WINDOW_MS = 3000;
export const OWNER_ENTRY_PATH = "/admin/review";

/**
 * Add a tap at `nowMs` to the recent taps. Taps older than the window are forgotten. `hit` is true
 * when the last OWNER_ENTRY_TAPS taps all fall inside the window; the count then starts over. Pure.
 */
export function registerTap(taps: readonly number[], nowMs: number): { taps: number[]; hit: boolean } {
  const recent = [...taps.filter((t) => nowMs - t <= OWNER_ENTRY_WINDOW_MS && t <= nowMs), nowMs].slice(-OWNER_ENTRY_TAPS);
  if (recent.length >= OWNER_ENTRY_TAPS) return { taps: [], hit: true };
  return { taps: recent, hit: false };
}

/** An onClick for the Support ID line: after the 5th quick tap it navigates the web view to the owner review. */
export function useOwnerEntryTap(
  go: (path: string) => void = (path) => window.location.assign(path),
  now: () => number = Date.now,
): () => void {
  const taps = useRef<number[]>([]);
  return useCallback(() => {
    const r = registerTap(taps.current, now());
    taps.current = r.taps;
    if (r.hit) go(OWNER_ENTRY_PATH);
  }, [go, now]);
}
