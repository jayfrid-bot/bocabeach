"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtTime } from "@/lib/format";
import { nearestServedBeach } from "@/lib/location/nearest";
import { plusErrorMessage } from "@/lib/plus/api";
import { useDeviceFix, type PlusState } from "@/lib/plus/client";
import type { LocationPublic } from "@/lib/types";

/** Inside this, you are at the beach and alerts arm themselves. */
const AT_BEACH_MI = 2;
const AUTO_ARM_MS = 4 * 3600 * 1000;
const MANUAL_ARM_MS = 6 * 3600 * 1000;
/** Never re-arm more than once a minute, however often the app foregrounds. */
const ARM_THROTTLE_MS = 60_000;

const CARD =
  "mb-4 rounded-2xl bg-white/80 px-4 py-3 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10";

/**
 * Beach Mode: the window in which this phone gets alerts computed from where it
 * is standing, not from the middle of the beach.
 *
 * Walking up with the app open arms it for four hours by itself and extends on
 * every foreground; anywhere else it is one tap for six. Free users see the same
 * card as a door — it explains what it does and opens the questions.
 *
 * App only: an alert with nowhere to be delivered is not worth offering.
 */
export function BeachModeCard({
  plus,
  native,
  slug,
  beaches,
  tz,
  onDoor,
}: {
  plus: PlusState;
  native: boolean;
  slug: string;
  beaches: LocationPublic[];
  tz: string;
  /** Free users tapping the card — open the Plus questions. */
  onDoor: () => void;
}) {
  const { fix } = useDeviceFix();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false); // the server said not-entitled
  const lastArmRef = useRef(0);

  const nearest = fix ? nearestServedBeach(fix.lat, fix.lon, beaches) : null;
  const atBeach = !!nearest && nearest.distanceMi <= AT_BEACH_MI;
  const presence = plus.device?.presence ?? null;
  const armed = !!presence && presence.armedUntil > Date.now();

  const arm = useCallback(
    async (ms: number, source: "auto" | "manual") => {
      const target = source === "auto" && nearest ? nearest.beach.slug : slug;
      const centroid = beaches.find((b) => b.slug === target);
      setBusy(true);
      setError(null);
      const res = await plus.arm({
        slug: target,
        lat: fix?.lat ?? centroid?.lat ?? null,
        lon: fix?.lon ?? centroid?.lon ?? null,
        accuracyM: fix?.accuracyM ?? null,
        fixAt: fix?.at ?? null,
        armedUntil: Date.now() + ms,
        source,
      });
      setBusy(false);
      if (res.ok) {
        setLocked(false);
        return;
      }
      // The server is the authority on entitlement: if it says no, this card
      // becomes the door again rather than arguing with a cached "yes".
      if (res.error === "not-entitled") setLocked(true);
      else setError(plusErrorMessage(res.error));
    },
    [beaches, fix, nearest, plus, slug],
  );

  // Auto-arm on arrival, and top the window up on every foreground.
  useEffect(() => {
    if (!native || !plus.entitled || locked || !atBeach) return;
    const armIfDue = () => {
      const now = Date.now();
      if (now - lastArmRef.current < ARM_THROTTLE_MS) return;
      lastArmRef.current = now;
      void arm(AUTO_ARM_MS, "auto");
    };
    armIfDue();
    const onVisible = () => {
      if (document.visibilityState === "visible") armIfDue();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [native, plus.entitled, locked, atBeach, arm]);

  const disarm = async () => {
    setBusy(true);
    setError(null);
    const res = await plus.disarm();
    setBusy(false);
    if (!res.ok && res.error !== "not-found") setError(plusErrorMessage(res.error));
  };

  if (!native) return null;

  // --- the door -------------------------------------------------------------
  if (!plus.entitled || locked) {
    return (
      <button type="button" onClick={onDoor} className={`${CARD} flex w-full items-center gap-3 text-left`}>
        <span aria-hidden className="shrink-0 text-xl leading-none">
          🛟
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-slate-900 dark:text-white">
            Get alerts where you stand
          </span>
          <span className="block text-xs leading-snug text-slate-600 dark:text-slate-400">
            Lightning, flags and rain measured from your spot on the sand, not the middle of the beach.
          </span>
        </span>
        <span aria-hidden className="shrink-0 text-slate-400">
          ›
        </span>
      </button>
    );
  }

  // --- armed ----------------------------------------------------------------
  if (armed && presence) {
    const until = fmtTime(new Date(presence.armedUntil).toISOString(), tz);
    return (
      <div className={CARD}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 text-sm text-slate-800 dark:text-slate-200">
            <span aria-hidden className="mr-1.5">
              🛟
            </span>
            <span className="font-semibold">Safety alerts on</span> until {until}
          </span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void arm(AUTO_ARM_MS, presence.source)}
              disabled={busy}
              className="inline-flex min-h-[40px] items-center rounded-full bg-slate-900/5 px-3.5 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-900/10 disabled:opacity-60 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10"
            >
              Extend
            </button>
            <button
              type="button"
              onClick={() => void disarm()}
              disabled={busy}
              className="inline-flex min-h-[40px] items-center rounded-full bg-slate-900/5 px-3.5 py-1.5 text-sm font-medium text-slate-700 transition hover:bg-slate-900/10 disabled:opacity-60 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-white/10"
            >
              Off
            </button>
          </div>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  // --- not armed ------------------------------------------------------------
  return (
    <div className={CARD}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="min-w-0 flex-1 text-sm text-slate-800 dark:text-slate-200">
          <span aria-hidden className="mr-1.5">
            🛟
          </span>
          {atBeach ? "Turning safety alerts on…" : "Heading to the beach?"}
        </span>
        <button
          type="button"
          onClick={() => void arm(MANUAL_ARM_MS, "manual")}
          disabled={busy}
          className="inline-flex min-h-[40px] shrink-0 items-center rounded-full bg-ocean-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ocean-700 disabled:opacity-60"
        >
          {busy ? "One moment…" : "Turn on for 6 hours"}
        </button>
      </div>
      {!fix ? (
        <p className="mt-1.5 text-xs leading-snug text-slate-500 dark:text-slate-400">
          Without a position we watch this beach rather than your exact spot.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : null}
    </div>
  );
}
