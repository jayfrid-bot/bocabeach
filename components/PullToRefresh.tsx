"use client";

import { useEffect, useRef, useState } from "react";

const TRIGGER_PX = 80; // pull past this before release to fire onRefresh
const MAX_PULL_PX = 120; // cap the indicator's offset
const RESIST = 0.55; // pulled distance feels naturally rubbery, not 1:1

/**
 * Touch-driven pull-to-refresh that wraps the page. While the scroll position
 * is at the very top, a downward swipe drags a circular indicator into view;
 * releasing past TRIGGER_PX calls onRefresh and shows a brief spinner.
 *
 * Works alongside the browser's overscroll behavior — we set
 * `overscroll-behavior-y: contain` in globals.css so the native browser
 * pull-to-refresh (which does a full page reload) doesn't fight us.
 *
 * onRefresh is awaited so the spinner stays visible until the data lands.
 */
export function PullToRefresh({
  onRefresh,
  children,
}: {
  onRefresh: () => Promise<unknown>;
  children: React.ReactNode;
}) {
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);
  const [pull, setPull] = useState(0); // 0..MAX_PULL_PX visual offset
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      // Only engage when we're at the very top — otherwise it's a normal scroll.
      if (window.scrollY > 0) return;
      // Don't fight other gestures (multi-touch zoom/swipe).
      if (e.touches.length !== 1) return;
      startY.current = e.touches[0].clientY;
      pulling.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startY.current == null || refreshing) return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) {
        // Upward / sideways — release the gesture so normal scrolling resumes.
        startY.current = null;
        if (pulling.current) {
          pulling.current = false;
          setPull(0);
        }
        return;
      }
      // Only stake a claim once we're past a small dead zone, so the gesture
      // doesn't snatch ordinary taps.
      if (!pulling.current && dy < 10) return;
      pulling.current = true;
      // Prevent the page from being dragged underneath the indicator.
      if (e.cancelable) e.preventDefault();
      const eased = Math.min(MAX_PULL_PX, dy * RESIST);
      setPull(eased);
    };

    const onTouchEnd = async () => {
      if (!pulling.current) {
        startY.current = null;
        return;
      }
      pulling.current = false;
      startY.current = null;
      const shouldFire = pull >= TRIGGER_PX;
      if (shouldFire) {
        setRefreshing(true);
        setPull(TRIGGER_PX); // hold the indicator in place during the spinner
        try {
          await onRefresh();
        } catch {
          // intentionally swallowed — the dashboard's normal error UI shows up
        } finally {
          setRefreshing(false);
          setPull(0);
        }
      } else {
        setPull(0);
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [onRefresh, pull, refreshing]);

  const progress = Math.min(1, pull / TRIGGER_PX);
  const visible = pull > 0 || refreshing;

  return (
    <>
      {/* Indicator floats above the page; the page content doesn't shift. */}
      <div
        aria-hidden={!visible}
        className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center"
        style={{
          transform: `translateY(${pull - 20}px)`,
          transition: refreshing || pull === 0 ? "transform 240ms ease" : "none",
          opacity: visible ? 1 : 0,
        }}
      >
        <div className="mt-2 flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10">
          {refreshing ? (
            <svg
              className="h-5 w-5 animate-spin text-ocean-600 dark:text-ocean-300"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              className="h-5 w-5 text-ocean-600 dark:text-ocean-300"
              style={{
                transform: `rotate(${progress * 180}deg)`,
                transition: "transform 120ms ease",
              }}
            >
              <path
                d="M12 4v14M6 14l6 6 6-6"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
      </div>
      {children}
    </>
  );
}
