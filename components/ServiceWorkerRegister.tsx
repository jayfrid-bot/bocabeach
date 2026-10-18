"use client";

import { useEffect, useState } from "react";
import { reloadHeld } from "@/lib/reloadGuard";
import {
  SAVED_NOTE_GIVE_UP_MS,
  formatSavedAt,
  optOutState,
  savedAtFromServerTiming,
  showSavedNote,
  shouldReloadForNewBuild,
  swDecision,
} from "@/lib/swClient";

/**
 * Runs the repeat-open service worker (public/sw.js; design in docs/SERVICE_WORKER.md).
 *
 * History: the first service worker cached the app shell and served stale JavaScript
 * inside the iOS shell, so it was retired and this component only unregistered. The new
 * worker is different: it shows the last copy at once but always fetches a fresh one
 * behind it, and it is never run inside the native shells. Where it must not run
 * (local dev, native shells, ?nosw=1) this component removes any worker and its caches.
 *
 * It also shows a slim note when the page on screen is a saved copy older than 30
 * minutes, until fresh data arrives. Copies under 30 minutes get no note.
 */

const BUILD_KEY = `${process.env.NEXT_PUBLIC_GIT_SHA ?? "dev"}-${process.env.NEXT_PUBLIC_BUILD_NUM ?? "0"}`;
const OPT_OUT_KEY = "ibd:sw";
const RELOAD_KEY = "ibd:swBuildReload";

type Note = { savedAt: number; state: "updating" | "failed" } | null;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage off: the opt-out then lasts for this page only */
  }
}

async function removeEverything(): Promise<void> {
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    // Ask our own worker to stop first: it wipes its caches and ignores late writes.
    regs.forEach((r) => (r.active ?? r.waiting ?? r.installing)?.postMessage({ type: "ibd-kill" }));
    await Promise.all(regs.map((r) => r.unregister()));
  } catch {
    /* best effort */
  }
  const wipe = async () => {
    try {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith("ibd-")).map((n) => caches.delete(n)));
    } catch {
      /* best effort */
    }
  };
  await wipe();
  setTimeout(() => void wipe(), 1500); // a refresh that was already in flight may write once more
}

/** When this page was saved by the worker, from its Server-Timing stamp. */
function savedAtOfThisPage(): number | null {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav ? savedAtFromServerTiming(nav.serverTiming ?? []) : null;
  } catch {
    return null;
  }
}

/** The build files this page loaded and the conditions call it made: what the worker should save. */
function loadedBuildFiles(): string[] {
  try {
    return performance
      .getEntriesByType("resource")
      .map((e) => e.name)
      .filter((n) => n.includes("/_next/static/") || n.includes("/api/conditions/"))
      .slice(0, 60);
  } catch {
    return [];
  }
}

export function ServiceWorkerRegister() {
  const [note, setNote] = useState<Note>(null);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const opt = optOutState(location.search, readStored(OPT_OUT_KEY));
    if (opt.store === "off") writeStored(OPT_OUT_KEY, "off");
    if (opt.store === "clear") writeStored(OPT_OUT_KEY, null);

    const decision = swDecision({
      production: process.env.NODE_ENV === "production",
      userAgent: navigator.userAgent,
      optedOut: opt.optedOut,
    });
    if (decision === "remove") {
      void removeEverything();
      return;
    }

    let cancelled = false;
    const openedAt = Date.now();
    let interacted = false;
    const touch = () => {
      interacted = true;
    };
    const touchEvents = ["pointerdown", "keydown", "touchstart", "wheel", "scroll"] as const;
    touchEvents.forEach((n) => window.addEventListener(n, touch, { passive: true, once: true }));

    // A saved copy older than 30 minutes gets a note until fresh data arrives.
    let giveUp: ReturnType<typeof setTimeout> | undefined;
    const savedAt = savedAtOfThisPage();
    if (savedAt != null && showSavedNote(savedAt, Date.now())) {
      setNote({ savedAt, state: "updating" });
      giveUp = setTimeout(() => setNote((n) => (n ? { ...n, state: "failed" } : n)), SAVED_NOTE_GIVE_UP_MS);
    }

    const onMessage = (e: MessageEvent) => {
      const type = (e.data as { type?: unknown } | null)?.type;
      if (type === "ibd-fresh") {
        if (giveUp) clearTimeout(giveUp);
        setNote(null);
      } else if (type === "ibd-fresh-failed") {
        if (giveUp) clearTimeout(giveUp);
        setNote((n) => (n ? { ...n, state: "failed" } : n));
      } else if (type === "ibd-build-changed") {
        let last: number | null = null;
        try {
          const raw = sessionStorage.getItem(RELOAD_KEY);
          last = raw ? Number(raw) : null;
        } catch {
          /* ignore */
        }
        const ok = shouldReloadForNewBuild({
          now: Date.now(),
          openedAt,
          interacted,
          dialogOpen: document.querySelector('[role="dialog"]') != null,
          held: reloadHeld(),
          lastReloadAt: last,
        });
        if (!ok) return;
        try {
          sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
        } catch {
          /* ignore */
        }
        location.reload();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    const start = async () => {
      if (cancelled) return;
      try {
        const reg = await navigator.serviceWorker.register(`/sw.js?v=${BUILD_KEY}`, {
          scope: "/",
          updateViaCache: "none",
        });
        // Check the worker file right now, so a fixed worker or the kill switch lands on this visit.
        void reg.update().catch(() => {});
        await navigator.serviceWorker.ready;
        const target = navigator.serviceWorker.controller ?? reg.active;
        target?.postMessage({ type: "ibd-warm", path: location.pathname, assets: loadedBuildFiles() });
      } catch {
        /* no worker: the site works exactly as before */
      }
    };
    // Never compete with the first paint: start once the page has loaded and gone quiet.
    const begin = () => {
      const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void })
        .requestIdleCallback;
      if (idle) idle(() => void start(), { timeout: 3000 });
      else setTimeout(() => void start(), 1500);
    };
    if (document.readyState === "complete") begin();
    else window.addEventListener("load", begin, { once: true });

    return () => {
      cancelled = true;
      if (giveUp) clearTimeout(giveUp);
      navigator.serviceWorker.removeEventListener("message", onMessage);
      window.removeEventListener("load", begin);
      touchEvents.forEach((n) => window.removeEventListener(n, touch));
    };
  }, []);

  if (!note) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-3 pt-[max(env(safe-area-inset-top),8px)]"
    >
      <span className="rounded-full bg-slate-900/85 px-3 py-1.5 text-xs text-white shadow-lg ring-1 ring-white/10">
        Showing saved conditions from {formatSavedAt(note.savedAt, Date.now())}.{" "}
        {note.state === "updating" ? "Updating…" : "Could not update yet."}
      </span>
    </div>
  );
}
