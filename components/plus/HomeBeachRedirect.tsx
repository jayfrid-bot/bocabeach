"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { getHomeBeach } from "@/lib/homeBeach";

/**
 * Open the app at the beach you actually go to.
 *
 * Only ever fires at "/" (which renders the flagship beach): a saved home beach
 * that is NOT the flagship replaces the route. Anywhere else — a shared link, a
 * beach the user navigated to on purpose — this does nothing. It runs at most
 * once per mount, so a route change can never bounce back and forth.
 */
export function HomeBeachRedirect({ flagshipSlug }: { flagshipSlug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const doneRef = useRef(false);

  useEffect(() => {
    if (doneRef.current) return;
    if (pathname !== "/") return;
    const home = getHomeBeach();
    if (!home || home === flagshipSlug) return;
    doneRef.current = true;
    router.replace(`/${home}`);
  }, [pathname, flagshipSlug, router]);

  return null;
}
