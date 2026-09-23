"use client";

import { useAppOpenPing } from "@/lib/useAppOpenPing";

/** Mounted once in the root layout (every page) — see lib/useAppOpenPing.ts. */
export function AppOpenPing() {
  useAppOpenPing();
  return null;
}
