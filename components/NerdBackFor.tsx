"use client";

import { NerdBack } from "@/components/FlipCard";
import { buildNerdInfo, type NerdContext } from "@/lib/nerdInfo";

/**
 * The data-nerd back face for one of the dashboard's standard cards. A default
 * export in its own file so next/dynamic can split it (and lib/nerdInfo.ts with
 * it) out of the first-load bundle — see components/nerdBackLoader.ts.
 */
export default function NerdBackFor({
  k,
  nerd,
}: {
  k: Parameters<typeof buildNerdInfo>[0];
  nerd: NerdContext;
}) {
  return <NerdBack info={buildNerdInfo(k, nerd)} />;
}
