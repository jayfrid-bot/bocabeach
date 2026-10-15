"use client";

import { useAppOpenPing } from "@/lib/useAppOpenPing";
import { useWatchSync } from "@/lib/useWatchSync";
import { usePushQueueRetry } from "@/lib/push/usePushQueueRetry";

/** Mounted once in the root layout (every page) — see lib/useAppOpenPing.ts.
 *  Also keeps the Apple Watch app's home beach current (lib/useWatchSync.ts) and
 *  retries, app-wide, a turn-off that never reached the server
 *  (lib/push/usePushQueueRetry.ts). */
export function AppOpenPing() {
  useAppOpenPing();
  useWatchSync();
  usePushQueueRetry();
  return null;
}
