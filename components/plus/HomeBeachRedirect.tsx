"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { getHomeBeach } from "@/lib/homeBeach";

/**
 * Where "/" should send this phone, or null to stay put. Pure, so the rules that
 * keep the front door working are a table test.
 *
 * Only ever fires at "/" (which renders the flagship beach): a saved home beach
 * that is NOT the flagship replaces the route. Anywhere else — a shared link, a
 * beach the user navigated to on purpose — this does nothing.
 *
 * A home beach the app no longer serves is ignored. `/<retired-slug>` 404s, and
 * the only way back from a 404 is "/", which would send them straight there
 * again: one renamed slug would otherwise brick the app's front door.
 */
export function homeRedirectTarget(
  pathname: string,
  home: string | null,
  flagshipSlug: string,
  served: readonly { slug: string }[],
): string | null {
  if (pathname !== "/") return null;
  if (!home || home === flagshipSlug) return null;
  if (!served.some((b) => b.slug === home)) return null;
  return `/${home}`;
}

/**
 * Open the app at the beach you actually go to. Runs at most once per mount, so
 * a route change can never bounce back and forth.
 */
export function HomeBeachRedirect({
  flagshipSlug,
  beaches,
}: {
  flagshipSlug: string;
  /** Every beach the app serves — a home beach outside this list is stale. */
  beaches: readonly { slug: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    const target = homeRedirectTarget(pathname, getHomeBeach(), flagshipSlug, beaches);
    if (!target) return;
    doneRef.current = true;
    router.replace(target);
  }, [pathname, flagshipSlug, beaches, router]);

  return null;
}
