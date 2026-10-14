"use client";

import { useAppOpenPing } from "@/lib/useAppOpenPing";
import { usePushQueueRetry } from "@/lib/push/usePushQueueRetry";

/** Mounted once in the root layout (every page) — see lib/useAppOpenPing.ts and
 *  lib/push/usePushQueueRetry.ts (the app-wide retry of a turn-off that never
 *  reached the server). */
export function AppOpenPing() {
  useAppOpenPing();
  usePushQueueRetry();
  return null;
}
