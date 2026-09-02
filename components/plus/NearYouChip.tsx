"use client";

import Link from "next/link";
import { useDeviceFix } from "@/lib/plus/client";
import { nearestServedBeach } from "@/lib/location/nearest";
import type { LocationPublic } from "@/lib/types";

/** One decimal under ten miles, whole numbers above — "0.4 mi", "38 mi". */
function miles(distanceMi: number): string {
  return distanceMi < 10 ? `${Math.round(distanceMi * 10) / 10} mi` : `${Math.round(distanceMi)} mi`;
}

/**
 * Where you are, relative to the beach on screen. Shown only once a position is
 * already known this session — this chip never asks for one, so it can never be
 * the reason a permission prompt appears.
 */
export function NearYouChip({
  beaches,
  currentSlug,
}: {
  beaches: LocationPublic[];
  currentSlug: string;
}) {
  const { fix } = useDeviceFix();
  if (!fix) return null;
  const nearest = nearestServedBeach(fix.lat, fix.lon, beaches);
  if (!nearest) return null;

  const here = nearest.beach.slug === currentSlug;
  const text = here
    ? `${miles(nearest.distanceMi)} from ${nearest.beach.name}`
    : `Nearest covered beach: ${nearest.beach.name}, ${miles(nearest.distanceMi)}`;

  return (
    <Link
      href="/find"
      className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-slate-900/5 px-3 py-1 text-xs font-medium text-slate-700 ring-1 ring-slate-900/10 transition hover:bg-slate-900/10 dark:bg-white/5 dark:text-slate-200 dark:ring-white/10"
    >
      <span aria-hidden>📍</span>
      {text}
    </Link>
  );
}
