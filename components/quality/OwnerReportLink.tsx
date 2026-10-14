"use client";

// A quiet "Report conditions" link at the foot of a beach page, shown only on a
// phone that has already passed the owner check once (lib/quality/client.ts sets
// the hint). It reads local storage and makes no request, so a visitor pays
// nothing for it. The hint only decides whether the link SHOWS; the report
// screen and its route do the real owner check.

import Link from "next/link";
import { useEffect, useState } from "react";
import { readOwnerHint } from "@/lib/quality/client";

export function OwnerReportLink({ slug }: { slug: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(readOwnerHint()), []);
  if (!show) return null;
  return (
    <p className="text-center text-xs">
      <Link
        href={`/admin/report?slug=${encodeURIComponent(slug)}`}
        className="inline-flex min-h-[44px] items-center text-ocean-700 hover:underline dark:text-ocean-300"
      >
        Report conditions
      </Link>
    </p>
  );
}
