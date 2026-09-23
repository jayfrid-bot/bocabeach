"use client";

import { useEffect, useRef, useState } from "react";
import { holdReload } from "@/lib/reloadGuard";
import { beginPullRefresh } from "@/lib/refreshInFlight";

const TRIGGER_PX = 80; // pull past this before release to fire onRefresh
const MAX_PULL_PX = 120; // cap the indicator's offset
const RESIST = 0.55; // pulled distance feels naturally rubbery, not 1:1
const MIN_SPINNER_MS = 700; // keep the spinner up at least this long, even on a cache hit
const REFRESH_DEADLINE_MS = 12_000; // give up on a hung refresh rather than stall forever
const BOUNCE_MS = 550; // content settle animation after a refresh completes
const PILL_MS = 2500; // how long the "Updated" pill stays up

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests — no DOM, no React).
// ---------------------------------------------------------------------------

/** Pulls a data timestamp out of whatever onRefresh resolved to. */
export function refreshedAt(result: unknown): Date | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { snapshot?: { generatedAt?: unknown }; generatedAt?: unknown };
  const raw = r.snapshot?.generatedAt ?? r.generatedAt;
  if (raw instanceof Date) {
    return isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === "string" || typeof raw === "number") {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

/** Awaits `promise`, but never resolves/rejects sooner than `ms` after it started. */
export async function withMinDuration<T>(promise: Promise<T>, ms: number): Promise<T> {
  const start = Date.now();
  const settle = async () => {
    const remaining = ms - (Date.now() - start);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  };
  try {
    const result = await promise;
    await settle();
    return result;
  } catch (err) {
    await settle();
    throw err;
  }
}

/** Thrown by withTimeout when `promise` doesn't settle within `ms`. */
export class RefreshTimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "RefreshTimeoutError";
  }
}

/** Rejects with RefreshTimeoutError if `promise` hasn't settled within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RefreshTimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** The pill's message, given whether the refresh succeeded and its data time.
 *  Never invents a time: a success with no known data time just says "Updated". */
export function pillText(status: "success" | "error", at: Date | null): string {
  if (status === "error") return "Couldn't refresh — showing the last data";
  if (!at) return "✓ Updated";
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `✓ Updated · data as of ${time}`;
}

// ---------------------------------------------------------------------------
// Phase state machine — a pure function so the transition table is testable
// without touching the DOM or React.
// ---------------------------------------------------------------------------

export type Phase = "idle" | "pulling" | "refreshing" | "bouncing";

export type PhaseEvent =
  | { type: "pull" } // finger has moved past the dead zone
  | { type: "release_below" } // released without reaching the trigger
  | { type: "release_above" } // released past the trigger — start refreshing
  | { type: "cancel" } // touchcancel — always back to idle, never fires onRefresh
  | { type: "settled" } // the refresh promise (success, error, or timeout) finished
  | { type: "bounce_done" }; // the settle-back animation finished

export function nextPhase(phase: Phase, event: PhaseEvent): Phase {
  switch (event.type) {
    case "cancel":
      return "idle";
    case "pull":
      return phase === "idle" || phase === "pulling" ? "pulling" : phase;
    case "release_below":
      return phase === "pulling" ? "idle" : phase;
    case "release_above":
      return phase === "pulling" ? "refreshing" : phase;
    case "settled":
      return phase === "refreshing" ? "bouncing" : phase;
    case "bounce_done":
      return phase === "bouncing" ? "idle" : phase;
    default:
      return phase;
  }
}

// ---------------------------------------------------------------------------

/**
 * Touch-driven pull-to-refresh that wraps the page. While the scroll position
 * is at the very top, a downward swipe drags the content (and a circular
 * indicator above it) down; releasing past TRIGGER_PX calls onRefresh, holds
 * a spinner for a minimum visible duration (capped by REFRESH_DEADLINE_MS),
 * then bounces the content back to rest and shows a brief "Updated" pill with
 * the refreshed data's time.
 *
 * Works alongside the browser's overscroll behavior — we set
 * `overscroll-behavior-y: contain` in globals.css so the native browser
 * pull-to-refresh (which does a full page reload) doesn't fight us.
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
  const [phase, setPhase] = useState<Phase>("idle");
  // Mirror the live pull distance so onTouchEnd can read it without the effect
  // re-subscribing every frame — listeners are wired up once on mount.
  const pullRef = useRef(0);
  pullRef.current = pull;
  const phaseRef = useRef<Phase>("idle");
  phaseRef.current = phase;
  // True once the user has interacted, so the first-load hint fades away.
  const [hinted, setHinted] = useState(false);
  // Only show the discoverability hint on touch-capable, first-load clients.
  const [showHint, setShowHint] = useState(false);
  // "Updated"/"Couldn't refresh" pill, shown for a few seconds after settling.
  const [pill, setPill] = useState<{ text: string; ok: boolean } | null>(null);
  // Whether the just-finished refresh succeeded — drives the bounce icon,
  // which shows before `pill` itself is set.
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const pillTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reducedMotion = useRef(false);
  // Guards every setState after an await — the component (or the whole page,
  // e.g. an in-app navigation) can unmount mid-refresh.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    reducedMotion.current =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  }, []);

  useEffect(() => {
    const dialogOpen = () =>
      document.body.style.overflow === "hidden" || document.querySelector('[role="dialog"]') !== null;

    const onTouchStart = (e: TouchEvent) => {
      // First touch anywhere retires the discoverability hint.
      setHinted(true);
      // Only engage when we're at the very top — otherwise it's a normal scroll.
      if (window.scrollY > 0) return;
      // Don't fight other gestures (multi-touch zoom/swipe).
      if (e.touches.length !== 1) return;
      // Don't steal the gesture from an open sheet/dialog/paywall.
      if (dialogOpen()) return;
      // Don't re-engage mid refresh/bounce.
      if (phaseRef.current !== "idle") return;
      startY.current = e.touches[0].clientY;
      pulling.current = false;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (startY.current == null || phaseRef.current === "refreshing" || phaseRef.current === "bouncing") return;
      const dy = e.touches[0].clientY - startY.current;
      if (dy <= 0) {
        // Upward / sideways — release the gesture so normal scrolling resumes.
        startY.current = null;
        if (pulling.current) {
          pulling.current = false;
          setPull(0);
          setPhase((p) => nextPhase(p, { type: "release_below" }));
        }
        return;
      }
      // Only stake a claim once we're past a small dead zone, so the gesture
      // doesn't snatch ordinary taps.
      if (!pulling.current && dy < 10) return;
      pulling.current = true;
      setPhase((p) => nextPhase(p, { type: "pull" }));
      // Prevent the page from being dragged underneath the indicator.
      if (e.cancelable) e.preventDefault();
      const eased = Math.min(MAX_PULL_PX, dy * RESIST);
      setPull(eased);
    };

    // touchcancel: the OS took the gesture (an edge swipe, an incoming call,
    // a system sheet). Always discard back to idle — never fire onRefresh,
    // even if the pull had already passed the trigger distance.
    const onTouchCancel = () => {
      if (!pulling.current) {
        startY.current = null;
        return;
      }
      pulling.current = false;
      startY.current = null;
      setPull(0);
      setPhase((p) => nextPhase(p, { type: "cancel" }));
    };

    const onTouchEnd = async () => {
      if (!pulling.current) {
        startY.current = null;
        return;
      }
      pulling.current = false;
      startY.current = null;
      // Read the live pull from the ref, not a closed-over state value.
      const shouldFire = pullRef.current >= TRIGGER_PX;
      if (!shouldFire) {
        setPull(0);
        setPhase((p) => nextPhase(p, { type: "release_below" }));
        return;
      }

      setPhase((p) => nextPhase(p, { type: "release_above" }));
      setPull(TRIGGER_PX); // hold the content/indicator in place during the spinner

      if (pillTimer.current) clearTimeout(pillTimer.current);
      if (bounceTimer.current) clearTimeout(bounceTimer.current);

      // Hold the version-reload guard for the whole refresh, and mark it as
      // in-flight for other refetch triggers (ConditionsDashboard's
      // resume-on-visibility refetch) — both released/cleared in `finally`.
      const releaseReloadHold = holdReload();
      const releasePullFlight = beginPullRefresh();

      let ok = true;
      let result: unknown;
      try {
        result = await withMinDuration(withTimeout(onRefresh(), REFRESH_DEADLINE_MS), MIN_SPINNER_MS);
      } catch {
        ok = false;
      } finally {
        releasePullFlight();
        releaseReloadHold();
      }

      if (!mountedRef.current) return;

      const text = pillText(ok ? "success" : "error", ok ? refreshedAt(result) : null);
      setLastOk(ok);

      // Bounce the content back to rest (skipped visually under reduced motion
      // by the app-wide prefers-reduced-motion rule in globals.css, which
      // collapses animation durations to ~0).
      setPhase((p) => nextPhase(p, { type: "settled" }));
      const bounceMs = reducedMotion.current ? 0 : BOUNCE_MS;
      bounceTimer.current = setTimeout(() => {
        if (!mountedRef.current) return;
        setPull(0);
        setPhase((p) => nextPhase(p, { type: "bounce_done" }));
        setPill({ text, ok });
        pillTimer.current = setTimeout(() => {
          if (mountedRef.current) setPill(null);
        }, PILL_MS);
      }, bounceMs);
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", onTouchCancel);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", onTouchCancel);
      if (pillTimer.current) clearTimeout(pillTimer.current);
      if (bounceTimer.current) clearTimeout(bounceTimer.current);
    };
  }, [onRefresh]);

  // Arm the first-load hint only on coarse-pointer (touch) clients. Runs once
  // after mount so server and client markup match (the hint never renders SSR).
  useEffect(() => {
    const coarse =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)").matches ||
        "ontouchstart" in window ||
        navigator.maxTouchPoints > 0);
    if (coarse) setShowHint(true);
  }, []);

  const progress = Math.min(1, pull / TRIGGER_PX);
  const indicatorVisible = pull > 0 || phase === "refreshing" || phase === "bouncing";
  // The hint shows until the first interaction, and yields the moment a real
  // pull begins so the two affordances never overlap.
  const hintVisible = showHint && !hinted && !indicatorVisible;
  const showCheck = phase === "bouncing" && lastOk === true;
  const showError = phase === "bouncing" && lastOk === false;
  const active = phase !== "idle";

  return (
    <>
      {/* Faint first-load affordance so the pull gesture is discoverable on
          touch devices. Fades out for good after the first interaction. */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-x-0 top-0 z-40 flex justify-center"
        style={{
          opacity: hintVisible ? 1 : 0,
          transform: `translateY(${hintVisible ? 0 : -6}px)`,
          transition: "opacity 500ms ease, transform 500ms ease",
        }}
      >
        <div className="mt-3 flex items-center gap-1.5 rounded-full bg-white/80 px-3 py-1 text-xs font-medium text-slate-500 shadow-sm ring-1 ring-slate-900/5 backdrop-blur dark:bg-slate-900/70 dark:text-slate-400 dark:ring-white/10">
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" aria-hidden>
            <path
              d="M12 4v14M6 14l6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Pull to refresh
        </div>
      </div>
      {/* Indicator sits in the gap the content's pull opens up above it. */}
      <div
        aria-hidden={!indicatorVisible}
        className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center"
        style={{
          transform: `translateY(${pull - 20}px)`,
          transition: phase === "idle" || phase === "refreshing" ? "transform 240ms ease" : "none",
          opacity: indicatorVisible ? 1 : 0,
        }}
      >
        <div className="mt-2 flex h-10 w-10 items-center justify-center rounded-full bg-white shadow-md ring-1 ring-slate-900/10 dark:bg-slate-900 dark:ring-white/10">
          {phase === "refreshing" ? (
            <svg
              className="h-5 w-5 animate-spin text-ocean-600 dark:text-ocean-300"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
              <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          ) : showCheck ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-ocean-600 dark:text-ocean-300" fill="none">
              <path
                d="M5 12.5l4.5 4.5L19 7"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : showError ? (
            <svg viewBox="0 0 24 24" className="h-5 w-5 text-slate-400 dark:text-slate-500" fill="none">
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
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
      {/* "Updated"/error pill, centered under the safe-area top inset. */}
      <div
        aria-hidden={pill === null}
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 z-50 flex justify-center"
        style={{
          top: "env(safe-area-inset-top, 0px)",
          opacity: pill ? 1 : 0,
          transition: "opacity 300ms ease",
        }}
      >
        <div
          className={
            pill?.ok === false
              ? "mt-2 rounded-full bg-slate-800 px-4 py-2 text-sm font-semibold text-white shadow-lg dark:bg-slate-200 dark:text-slate-900"
              : "mt-2 rounded-full bg-ocean-600 px-4 py-2 text-sm font-semibold text-white shadow-lg dark:bg-ocean-400 dark:text-slate-950"
          }
        >
          {pill?.text ?? ""}
        </div>
      </div>
      {/* Content follows the finger while pulling/refreshing/bouncing; `transform:
          none` at rest so `position: fixed` descendants (sheets, paywall, share
          sheet) aren't broken by a stray ancestor transform. */}
      <div
        className={phase === "bouncing" && !reducedMotion.current ? "ptr-bounce" : undefined}
        style={
          phase === "bouncing" && !reducedMotion.current
            ? // Let the ptr-bounce keyframes (globals.css) drive transform from
              // this starting offset through the overshoot down to rest.
              ({ "--ptr-start": `${pull}px` } as React.CSSProperties)
            : {
                transform: active ? `translateY(${pull}px)` : "none",
                transition: phase === "pulling" ? "none" : "none",
              }
        }
      >
        {children}
      </div>
    </>
  );
}
