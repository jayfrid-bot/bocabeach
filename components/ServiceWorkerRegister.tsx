"use client";

import { useEffect } from "react";

/**
 * The PWA service worker was retired: it cached the app shell and served stale
 * JavaScript across deploys inside the Capacitor remote-URL shell (a real
 * force-quit still ran old code). We now actively unregister any lingering
 * worker. public/sw.js is a self-clearing kill-switch that wipes its caches,
 * unregisters, and reloads the page for clients still controlled by the old
 * worker — so this name (kept for the component contract) now means "ensure no
 * service worker is in the way."
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => regs.forEach((r) => r.unregister()))
      .catch(() => {
        /* best effort */
      });
  }, []);
  return null;
}
