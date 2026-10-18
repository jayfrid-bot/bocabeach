"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ZoomableImage } from "@/components/ZoomableImage";

/**
 * Full-screen view of one live cam still, zoomable (pinch, double-tap, wheel,
 * or the + / − buttons). Opened by tapping a cam in CamGrid. The live video
 * still sits one tap away ("Watch live"), and the owner's credit stays on
 * screen as everywhere else the picture is shown.
 *
 * Keyboard: Escape closes, Tab stays inside, focus goes back to the tapped cam.
 */
export function CamLightbox({
  src,
  name,
  credit,
  liveUrl,
  stamp,
  onClose,
}: {
  src: string;
  name: string;
  credit?: string;
  liveUrl?: string;
  /** e.g. "📷 4:52 PM" — when the still was taken. */
  stamp?: string;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.querySelector<HTMLElement>("button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close.current();
      } else if (e.key === "Tab") {
        const items = Array.from(
          root.current?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]") ?? [],
        );
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !root.current?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !root.current?.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      opener?.focus();
    };
  }, []);

  const NAV =
    "flex h-12 w-12 items-center justify-center rounded-full bg-white/15 text-2xl text-white transition hover:bg-white/25";
  return createPortal(
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`${name}, full screen`}
      className="fixed inset-0 z-[60] flex flex-col bg-black pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2 text-white">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          {stamp ? <p className="truncate text-[11px] text-white/60">{stamp}</p> : null}
        </div>
        <button type="button" onClick={onClose} aria-label="Close full screen" className={NAV}>
          <span aria-hidden>{"✕"}</span>
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ZoomableImage src={src} alt={`${name}, live still`} />
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3 text-white">
        <p className="min-w-0 flex-1 text-[11px] leading-snug text-white/70">
          {credit ?? ""}
          <span className="block text-white/50">Pinch or double-tap to zoom.</span>
        </p>
        {liveUrl ? (
          <a
            href={liveUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[44px] shrink-0 items-center rounded-full bg-white/15 px-4 text-sm font-medium text-white transition hover:bg-white/25"
          >
            Watch live {"↗"}
          </a>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
