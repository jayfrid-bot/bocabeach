"use client";

import { useAppOpenPing } from "@/lib/useAppOpenPing";
import { useWatchSync } from "@/lib/useWatchSync";

/** Mounted once in the root layout (every page) — see lib/useAppOpenPing.ts.
 *  Also keeps the Apple Watch app's home beach current (lib/useWatchSync.ts). */
export function AppOpenPing() {
  useAppOpenPing();
  useWatchSync();
  return null;
}
