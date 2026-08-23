"use client";

import { useEffect, useState } from "react";
import { fmtRelative } from "@/lib/format";

/**
 * Wall-clock "now" in ms, client-only: null on the server and for the first
 * client render so the prerendered HTML and hydration agree. (Reading
 * Date.now() during render was a real hydration mismatch — React #418 — once
 * the statically generated page was a minute old.)
 *
 * Ticks every minute, AND re-reads the clock the moment the page comes back:
 * iOS suspends JS timers while the app is backgrounded and does not fire the
 * missed interval on resume, so without this a "3 min ago" label could sit
 * under an hours-old picture until the next tick. visibilitychange covers the
 * app switcher, focus covers window switching, and pageshow covers the
 * back/forward cache in the WKWebView shell.
 */
export function useNowMs(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", tick);
    window.addEventListener("pageshow", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", tick);
      window.removeEventListener("pageshow", tick);
    };
  }, []);
  return now;
}

/**
 * Client-only "Xm ago" stamp. Relative times read the clock, so rendering them
 * during SSR makes the server and the hydrating client disagree whenever a
 * minute ticks over in between. Render a placeholder until mounted, then keep
 * the label fresh — every minute, and immediately when the page resumes.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const now = useNowMs();
  return <>{now == null ? "…" : fmtRelative(iso, now)}</>;
}
