"use client";

import { useEffect } from "react";

/**
 * Registers the PWA service worker (public/sw.js) in the browser. Production
 * only — registering in dev fights with hot-reload and caches stale chunks.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* installability is a progressive enhancement; ignore failures */
      });
    };
    window.addEventListener("load", register);
    return () => window.removeEventListener("load", register);
  }, []);
  return null;
}
