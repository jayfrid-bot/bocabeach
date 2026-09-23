"use client";

import { useReloadOnNewVersion } from "@/lib/useReloadOnNewVersion";

/** Mounted once in the root layout (every page) — see lib/useReloadOnNewVersion.ts. */
export function ReloadOnNewVersion() {
  useReloadOnNewVersion();
  return null;
}
