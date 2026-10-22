"use client";

import { useEffect, useState } from "react";
import { CAMPAIGN, campaignForBeach, campaignLive } from "@/lib/campaignBanner";

const DISMISS_KEY = `campaign-dismissed:${CAMPAIGN.id}`;

/** The slim "Re-elect Marci Woodward" strip (lib/campaignBanner.ts). Website only, District 4
 *  only, gone at poll close, and closable. Decided after mount, so cached pages stay shared. */
export function CampaignBanner({ slug, native }: { slug: string; native: boolean }) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (native) return;
    const now = Date.now();
    if (!campaignLive(now)) return;
    try {
      if (localStorage.getItem(DISMISS_KEY)) return;
    } catch {
      /* storage blocked: still fine to show */
    }
    if (campaignForBeach(slug, now)) {
      setShow(true);
      return;
    }
    let alive = true;
    fetch("/api/campaign", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { show?: boolean } | null) => {
        if (alive && d?.show === true && campaignLive(Date.now())) setShow(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [slug, native]);

  if (!show) return null;
  const close = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
  };
  return (
    <aside
      aria-label="Election endorsement"
      className="mb-3 flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-slate-800 ring-1 ring-amber-200 dark:bg-amber-400/10 dark:text-slate-100 dark:ring-amber-300/20"
    >
      <span aria-hidden>🗳️</span>
      <a href={CAMPAIGN.href} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 leading-snug hover:underline">
        <span className="font-semibold">{CAMPAIGN.headline}</span>{" "}
        <span className="text-slate-600 dark:text-slate-300">{CAMPAIGN.sub}</span>{" "}
        <span className="whitespace-nowrap font-medium text-ocean-700 dark:text-ocean-300">{CAMPAIGN.cta} ↗</span>
        {CAMPAIGN.disclaimer ? <span className="mt-0.5 block text-[10px] text-slate-500">{CAMPAIGN.disclaimer}</span> : null}
      </a>
      <button
        type="button"
        onClick={close}
        aria-label="Hide this message"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-500 transition hover:bg-black/5 dark:hover:bg-white/10"
      >
        <span aria-hidden>✕</span>
      </button>
    </aside>
  );
}
