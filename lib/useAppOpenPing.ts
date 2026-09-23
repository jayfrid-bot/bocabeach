"use client";

import { useEffect } from "react";
import { getDeviceId } from "@/lib/deviceId";
import { nativePlatform } from "@/lib/push/native";

/**
 * Tell the server "this device opened the app today", at most once per
 * calendar day. Feeds the daily/weekly active-user counts (/api/open).
 *
 * It checks on load AND on every return to the foreground, because the iOS
 * shell keeps the page alive in the background for days — a person who opens
 * the app every morning may never trigger a fresh page load.
 */

const STORAGE_KEY = "bd:open-day";

/** The calendar day at the beach, the same definition the server uses
 *  (lib/db/scanFunnel.ts localDay) — kept local so the client bundle does not
 *  pull in server code. */
function localDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

/** Pure decision: ping unless this device already pinged today. Automated
 *  browsers (tests, crawlers that run JS) never count as people. */
export function shouldPing(lastDay: string | null, today: string, automated: boolean): boolean {
  if (automated) return false;
  return lastDay !== today;
}

function readLastDay(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function ping(): void {
  const today = localDay(Date.now());
  if (!shouldPing(readLastDay(), today, navigator.webdriver === true)) return;
  const deviceId = getDeviceId();
  if (!deviceId) return; // storage disabled: no stable id, nothing to count
  try {
    localStorage.setItem(STORAGE_KEY, today); // mark first, so a double event can't double-send
  } catch {
    return;
  }
  const body = JSON.stringify({ deviceId, platform: nativePlatform() });
  fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => {
    // Offline: forget the mark so the next foreground tries again.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* best effort */
    }
  });
}

/** Mount once in the root layout (every page). */
export function useAppOpenPing(): void {
  useEffect(() => {
    ping();
    const onVisible = () => {
      if (document.visibilityState === "visible") ping();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);
}
