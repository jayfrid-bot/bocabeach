"use client";

import { useEffect, useState } from "react";

const APP_STORE_URL = "https://apps.apple.com/us/app/id6779072992";
const DISMISS_KEY = "ibd.appStoreBand.dismissed";

/**
 * Tracks the OS "reduce motion" setting on the client. Same pattern as
 * FlipCard's usePrefersReducedMotion: defaults to false so SSR/first paint
 * always match, then refines after mount.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * Quiet "now on the App Store" band for the web/PWA surface. The caller (see
 * ConditionsDashboard) only renders this when `!isNativeApp` — someone already
 * reading the site inside the iOS app has the app and should never be asked
 * to go download it.
 *
 * Defaults to visible; a dismissal is remembered in localStorage so it doesn't
 * come back for people who already closed it. We deliberately don't hide the
 * band pre-mount and re-show it — that would flash for EVERY visitor. Instead
 * it renders visible on first paint and, for the small set of people who have
 * a stored dismissal, disappears a beat after mount. That brief flash only
 * touches returning dismissers, not the general audience.
 */
export function AppStoreBand() {
  const [dismissed, setDismissed] = useState(false);
  const reducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    if (localStorage.getItem(DISMISS_KEY) === "1") setDismissed(true);
  }, []);

  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1");
    setDismissed(true);
  };

  return (
    <div className="relative mb-6 overflow-hidden rounded-2xl bg-gradient-to-r from-sky-50 via-white to-white px-4 py-3 ring-1 ring-slate-900/10 dark:from-slate-800/60 dark:via-slate-900/70 dark:to-slate-900/70 dark:ring-white/10">
      <div className="flex flex-col gap-3 pr-8 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:pr-10">
        <div className="flex min-w-0 items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icon-192.png"
            alt=""
            aria-hidden="true"
            width={40}
            height={40}
            className="h-10 w-10 shrink-0 rounded-xl outline outline-1 outline-black/10 dark:outline-white/10"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-balance text-slate-900 dark:text-white">
              Is It Beach Day is on the App Store
            </p>
            <p className="line-clamp-2 text-pretty text-xs text-slate-600 dark:text-slate-400 sm:line-clamp-1">
              The full beach score, live cams, and an optional morning heads-up. Free.
            </p>
          </div>
        </div>
        <a
          href={APP_STORE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`inline-flex shrink-0 self-start rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent sm:self-auto ${
            reducedMotion ? "" : "active:scale-[0.96] transition-transform"
          }`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/app-store-badge.svg"
            alt="Download on the App Store"
            width={120}
            height={40}
          />
        </a>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center text-slate-400 transition hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500/70 dark:text-slate-500 dark:hover:text-slate-300"
      >
        <span aria-hidden className="text-base leading-none">
          ×
        </span>
      </button>
    </div>
  );
}
