"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { setHomeBeach } from "@/lib/homeBeach";
import { nearestServedBeach } from "@/lib/location/nearest";
import type { PlusState } from "@/lib/plus/client";
import { useDeviceFix } from "@/lib/plus/client";
import { readFirstRunDone, writeFirstRunDone } from "@/lib/plus/storage";
import type { LocationPublic } from "@/lib/types";

/** Past this, "your nearest beach" is a place you are not going today. */
const HOME_RADIUS_MI = 30;

type State = "offer" | "locating" | "far" | "hidden";

/**
 * The only thing the app ever asks on a first launch, and it asks in one line
 * that nothing waits behind: the dashboard is already there underneath it.
 * Answer it or dismiss it and it never comes back.
 */
export function FirstRunBanner({
  plus,
  beaches,
  currentSlug,
  flagshipSlug,
}: {
  plus: PlusState;
  beaches: LocationPublic[];
  currentSlug: string;
  /** The beach "/" renders. Choosing it means staying on "/". */
  flagshipSlug: string;
}) {
  const router = useRouter();
  const fix = useDeviceFix();
  const [state, setState] = useState<State>("hidden");
  const [far, setFar] = useState<{ name: string; slug: string; mi: number } | null>(null);

  useEffect(() => {
    if (!readFirstRunDone()) setState("offer");
  }, []);

  const dismiss = () => {
    writeFirstRunDone(true);
    setState("hidden");
  };

  const find = async () => {
    setState("locating");
    const got = await fix.request();
    writeFirstRunDone(true);
    if (!got) {
      // Denied, unavailable, or timed out. Say nothing — this was optional.
      setState("hidden");
      return;
    }
    const nearest = nearestServedBeach(got.lat, got.lon, beaches);
    if (!nearest) {
      setState("hidden");
      return;
    }
    const mi = Math.round(nearest.distanceMi);
    if (nearest.distanceMi > HOME_RADIUS_MI) {
      setFar({ name: nearest.beach.name, slug: nearest.beach.slug, mi });
      setState("far");
      return;
    }
    setHomeBeach(nearest.beach.slug);
    void plus.setHome(nearest.beach.slug);
    setState("hidden");
    if (nearest.beach.slug !== currentSlug) {
      router.replace(nearest.beach.slug === flagshipSlug ? "/" : `/${nearest.beach.slug}`);
    }
  };

  if (state === "hidden") return null;

  if (state === "far" && far) {
    return (
      <Wrapper onDismiss={dismiss}>
        <p className="text-sm text-slate-700 dark:text-slate-200">
          Nearest covered beach: {far.name}, {far.mi} mi.{" "}
          <Link
            href={far.slug === flagshipSlug ? "/" : `/${far.slug}`}
            className="font-medium text-ocean-700 underline dark:text-ocean-300"
          >
            Open it
          </Link>
        </p>
      </Wrapper>
    );
  }

  return (
    <Wrapper onDismiss={dismiss}>
      {/* Stacked on a phone, side by side once there is room: the button's own
          label is nearly a phone-width wide, so sharing a line squeezes the
          sentence into one word per row. */}
      <div className="sm:flex sm:items-center sm:gap-3">
        <p className="text-sm text-slate-700 dark:text-slate-200">
          Want the beach closest to you?
        </p>
        <button
          type="button"
          onClick={() => void find()}
          disabled={state === "locating"}
          className="mt-2 inline-flex min-h-[40px] shrink-0 items-center rounded-full bg-ocean-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-ocean-700 disabled:opacity-60 sm:mt-0"
        >
          {state === "locating" ? "Looking…" : "Find my nearest beach"}
        </button>
      </div>
    </Wrapper>
  );
}

function Wrapper({
  children,
  onDismiss,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      role="region"
      aria-label="Nearest beach"
      className="mb-4 flex items-start gap-2 rounded-2xl bg-ocean-500/10 px-4 py-3 ring-1 ring-ocean-500/20"
    >
      <span aria-hidden className="mt-1.5 shrink-0 text-base leading-none">
        📍
      </span>
      <div className="min-w-0 flex-1">{children}</div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-slate-900/5 dark:hover:bg-white/10"
      >
        <span aria-hidden className="text-base leading-none">
          ✕
        </span>
      </button>
    </div>
  );
}
