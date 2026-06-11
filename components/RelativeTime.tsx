"use client";

import { useEffect, useState } from "react";
import { fmtRelative } from "@/lib/format";

/**
 * Client-only "Xm ago" stamp. Relative times read the clock, so rendering them
 * during SSR makes the server and the hydrating client disagree whenever a
 * minute ticks over in between. Render a placeholder until mounted, then keep
 * the label fresh every minute.
 */
export function RelativeTime({ iso }: { iso: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return <>{now == null ? "…" : fmtRelative(iso)}</>;
}
