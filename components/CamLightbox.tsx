"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ZoomableImage } from "@/components/ZoomableImage";

/**
 * Full-screen view of one live cam still, zoomable (pinch, double-tap, wheel,
 * or the + / − buttons). Opened by tapping a cam in CamGrid. The live video
 * still sits one tap away ("Watch live"), and the owner's credit stays on
 * screen as everywhere else the picture is shown.
 *
 * Keyboard: Escape closes, Tab stays inside, focus goes back to the tapped cam.
 * While open, the page under it is inert and hidden from screen readers, and
 * the whole overlay takes every touch, so a pinch or drag on its header or
 * footer cannot zoom or scroll the page behind it.
 */
export function CamLightbox({
  src,
  name,
  credit,
  liveUrl,
  stamp,
  openerRef,
  onClose,
}: {
  src: string;
  name: string;
  credit?: string;
  liveUrl?: string;
  /** e.g. "📷 4:52 PM" — when the still was taken. */
  stamp?: string;
  /** The tapped cam: focus goes back to it on close. (iOS does not focus a
   *  tapped button, so document.activeElement cannot be trusted for this.) */
  openerRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement | null>(null);
  // The picture as it was when opened. The page refreshes its data every few
  // minutes and that changes the cam URL; following it would reload the
  // picture and throw away the viewer's zoom.
  const [frozenSrc] = useState(src);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener = openerRef?.current ?? null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Everything else on the page goes inert while the viewer is open.
    const hidden: HTMLElement[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === root.current || !(el instanceof HTMLElement) || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      el.setAttribute("aria-hidden", "true");
      hidden.push(el);
    }
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
      for (const el of hidden) {
        el.removeAttribute("inert");
        el.removeAttribute("aria-hidden");
      }
      opener?.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- set up once per open; the opener is read at open time on purpose
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
      style={{ touchAction: "none", overscrollBehavior: "contain" }}
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
        <ZoomableImage src={frozenSrc} alt={`${name}, live still`} />
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
