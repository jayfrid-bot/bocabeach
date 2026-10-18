"use client";

import { useEffect, useRef } from "react";
import type { ConditionsResponse } from "@/lib/types";
import { freshConditionsFromMessage, leanDataPath } from "@/lib/swClient";

/**
 * Two small jobs for the dashboard (see docs/SERVICE_WORKER.md):
 *
 * 1. Performance mark. `ibd:score-rendered` is set once, after the first paint that
 *    follows hydration. The score is already in the server HTML, so this is the latest
 *    moment it can be on screen. scripts/sw-bench.mjs reads it.
 * 2. Fresh data from the service worker. On a repeat open the worker answers the page
 *    and the first conditions call from its cache, then fetches new data behind them.
 *    When that lands it posts the new snapshot here and the dashboard swaps it in.
 *    The worker posts the lean route's packed form; it is unpacked before use.
 *    Without a worker (first visit, native app, dev) nothing arrives and nothing changes.
 * 3. Data warm-up. The page no longer calls the data route on load when its HTML is
 *    fresh, so it asks the worker to save this beach's data once (skipped when saved).
 */
export function useSwRevalidate(
  slug: string,
  preview: boolean,
  latestGeneratedAtRef: { current: string },
  apply: (fresh: ConditionsResponse) => void,
): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    let id2 = 0;
    const id1 = requestAnimationFrame(() => {
      id2 = requestAnimationFrame(() => {
        try {
          performance.mark("ibd:score-rendered");
        } catch {
          /* no Performance API: nothing to mark */
        }
      });
    });
    return () => {
      cancelAnimationFrame(id1);
      cancelAnimationFrame(id2);
    };
  }, []);

  useEffect(() => {
    if (preview || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const fresh = freshConditionsFromMessage(e.data, slug, latestGeneratedAtRef.current);
      if (!fresh) return;
      latestGeneratedAtRef.current = fresh.snapshot.generatedAt;
      applyRef.current(fresh);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [slug, preview, latestGeneratedAtRef]);

  useEffect(() => {
    if (preview || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    // `ready` only settles once components/ServiceWorkerRegister.tsx has registered the
    // worker (production web only), so the native shells and dev never get here.
    navigator.serviceWorker.ready
      .then((reg) => {
        if (cancelled) return;
        const target = navigator.serviceWorker.controller ?? reg.active;
        target?.postMessage({ type: "ibd-warm", assets: [location.origin + leanDataPath(slug)] });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug, preview]);
}
