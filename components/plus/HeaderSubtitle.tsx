"use client";

import { useDeviceFix } from "@/lib/plus/client";
import { distanceToBeachMi } from "@/lib/location/shoreDistance";
import type { LocationPublic } from "@/lib/types";

/** One decimal under ten miles, whole numbers above — "0.4 mi", "38 mi".
 *  Matches NearYouChip's own formatting so the same fix reads the same way
 *  everywhere it shows up. */
function miles(distanceMi: number): string {
  return distanceMi < 10 ? `${Math.round(distanceMi * 10) / 10} mi` : `${Math.round(distanceMi)} mi`;
}

/**
 * The one muted line under the header's beach name: how far away it is, when
 * a device position is already known (this never asks for one — see
 * useDeviceFix), plus the auto-tier heads-up, shortened to fit one line.
 *
 * Beach Mode's "alerts on until …" state (armedUntil) lives inside
 * BeachModeCard's own private SWR fetch, not in anything passed down from
 * ConditionsDashboard or usePlus — surfacing it here would mean a second,
 * duplicate fetch of the same endpoint. Left out on purpose; distance and the
 * auto-tier note still show.
 */
export function HeaderSubtitle({
  beach,
  isAutoTier,
}: {
  beach: LocationPublic;
  isAutoTier: boolean;
}) {
  const { fix } = useDeviceFix();
  const distance = fix ? miles(distanceToBeachMi(fix.lat, fix.lon, beach)) : null;

  if (!distance && !isAutoTier) return null;

  return (
    <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">
      {distance ? `${distance} away` : null}
      {distance && isAutoTier ? " · " : null}
      {isAutoTier ? "Auto-resolved — some local data pending" : null}
    </p>
  );
}
