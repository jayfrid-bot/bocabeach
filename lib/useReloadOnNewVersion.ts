"use client";

import { useEffect, useRef } from "react";
import { reloadHeld } from "@/lib/reloadGuard";

/**
 * Reload the app when a new build has deployed.
 *
 * The iOS shell (Capacitor) keeps the page alive in the background across app
 * switches — ConditionsDashboard already refetches DATA on resume, but never
 * picks up new CODE, so a reader could sit on yesterday's JS indefinitely
 * (they'd see stale UI even though the data underneath had moved on). This
 * hook polls /api/version on resume and reloads the page once the deployed
 * SHA has actually changed.
 */

const CHECK_INTERVAL_MS = 60_000;
/** sessionStorage key for the loop guard — the last target SHA we already
 *  reloaded for, so a flaky /api/version response can't reload twice. */
const STORAGE_KEY = "ibd:reloadTargetSha";

/**
 * Pure decision: should the page reload for this `served` SHA?
 *  - `baked` is the SHA this bundle was built with (NEXT_PUBLIC_GIT_SHA).
 *  - `served` is what /api/version reports right now.
 *  - `alreadyTried` is the last target SHA we already reloaded for this
 *    session (the loop guard) — never reload twice for the same target.
 * A local dev build (`baked === "dev"`) never reloads: there is no real
 * deploy to catch up to, and the SHA is meaningless there.
 */
export function shouldReload(
  baked: string,
  served: string | null | undefined,
  alreadyTried: string | null | undefined,
): boolean {
  if (baked === "dev") return false;
  if (!served) return false;
  if (served === baked) return false;
  if (served === alreadyTried) return false;
  return true;
}

function readTriedSha(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeTriedSha(sha: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, sha);
  } catch {
    /* best effort — private browsing / storage disabled, etc. */
  }
}

/** True while a paywall, sheet, or any other dialog is open — a reload mid-flow
 *  would blow it away, so this defers exactly like reloadHeld() does. */
function dialogOpen(): boolean {
  try {
    return document.querySelector('[role="dialog"]') != null;
  } catch {
    return false;
  }
}

/**
 * Mount once, anywhere rendered on every page (the root layout's client shell,
 * or a dashboard mounted on every route). Checks /api/version whenever the
 * page comes back on screen (visibility change to "visible", or a bfcache
 * pageshow), throttled to once per 60s, and reloads via `location.reload()`
 * the first time the served SHA differs from the one this bundle was built
 * with. Never checks — and so never reloads — on the very first mount; only
 * on a later resume.
 */
export function useReloadOnNewVersion(): void {
  const lastCheckAtRef = useRef(0);

  useEffect(() => {
    const baked = process.env.NEXT_PUBLIC_GIT_SHA ?? "dev";
    if (baked === "dev") return; // nothing to reconcile against in local dev

    const check = () => {
      const now = Date.now();
      if (now - lastCheckAtRef.current < CHECK_INTERVAL_MS) return;
      lastCheckAtRef.current = now;

      fetch("/api/version", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { sha?: unknown } | null) => {
          const served = typeof data?.sha === "string" ? data.sha : null;
          if (!shouldReload(baked, served, readTriedSha())) return;
          // A purchase/restore/redeem or a Beach Mode arm/disarm/location
          // request is in flight, or a dialog (paywall/sheet) is open — a
          // reload right now would blow it away. Skip WITHOUT marking this
          // SHA as tried, so the next resume's check tries again.
          if (reloadHeld() || dialogOpen()) return;
          writeTriedSha(served as string);
          window.location.reload();
        })
        .catch(() => {
          /* best effort — a network hiccup just skips this check */
        });
    };

    // visibilitychange -> "visible" covers the iOS-shell app-switch resume.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") check();
    };
    // pageshow fires on the FIRST load too (event.persisted === false); only
    // a bfcache restore (persisted === true) is a "resume", so that's the
    // only pageshow case this checks — the first-mount guard the task calls
    // for falls straight out of that, no extra bookkeeping needed.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) check();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);
}
