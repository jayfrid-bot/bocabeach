"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A picture you can zoom: pinch with two fingers, double-tap (or double-click)
 * to zoom in on a spot and again to zoom back out, drag to pan while zoomed,
 * and the wheel or trackpad pinch on a computer. The +, − and reset buttons do
 * the same from the keyboard or for anyone who cannot pinch.
 *
 * Built for the full-screen cam viewers (CamLightbox, the Day View). It owns
 * every touch inside its box (`touch-action: none`), so the page itself never
 * zooms or scrolls under the picture. Pure CSS transform, no library.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 };

/** Keep the zoomed picture over the box: at scale s the picture is s times the
 *  box, so it may slide at most (s − 1) / 2 of the box each way. */
export function clampZoom(z: ZoomState, w: number, h: number): ZoomState {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, z.scale));
  if (scale === 1) return IDENTITY;
  const mx = (w * (scale - 1)) / 2;
  const my = (h * (scale - 1)) / 2;
  return {
    scale,
    x: Math.min(mx, Math.max(-mx, z.x)),
    y: Math.min(my, Math.max(-my, z.y)),
  };
}

/** Zoom to `next` scale keeping the point (px, py) — measured from the box
 *  centre — still under the finger or cursor. */
export function zoomAt(z: ZoomState, next: number, px: number, py: number): ZoomState {
  const ratio = next / z.scale;
  return { scale: next, x: px - (px - z.x) * ratio, y: py - (py - z.y) * ratio };
}

export function ZoomableImage({
  src,
  alt,
  onError,
  onZoomedChange,
  className = "",
}: {
  src: string;
  alt: string;
  onError?: () => void;
  /** Tells the parent when the picture leaves or returns to 1×, e.g. to pause
   *  swipe or arrow-key navigation while the viewer is zoomed. */
  onZoomedChange?: (zoomed: boolean) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [zoom, setZoomState] = useState<ZoomState>(IDENTITY);
  // True while a finger or the mouse is down: the picture then follows it with no easing.
  const [touching, setTouching] = useState(false);
  const zoomRef = useRef<ZoomState>(IDENTITY);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; start: ZoomState; mid: { x: number; y: number } } | null>(null);
  const pan = useRef<{ x: number; y: number; start: ZoomState } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const zoomedCb = useRef(onZoomedChange);
  useEffect(() => {
    zoomedCb.current = onZoomedChange;
  });

  const setZoom = useCallback((next: ZoomState) => {
    const el = box.current;
    const clamped = el ? clampZoom(next, el.clientWidth, el.clientHeight) : next;
    const wasZoomed = zoomRef.current.scale > 1;
    zoomRef.current = clamped;
    setZoomState(clamped);
    if (wasZoomed !== clamped.scale > 1) zoomedCb.current?.(clamped.scale > 1);
  }, []);

  // A new picture starts at 1×.
  useEffect(() => {
    setZoom(IDENTITY);
  }, [src, setZoom]);

  /** A point relative to the box centre. */
  const local = (clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Buttons inside the box keep their own clicks.
    if ((e.target as HTMLElement).closest("button")) return;
    try {
      box.current?.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks cannot be captured; moves still arrive.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setTouching(true);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        start: zoomRef.current,
        mid: local((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      pan.current = null;
    } else if (pointers.current.size === 1) {
      pan.current = { x: e.clientX, y: e.clientY, start: zoomRef.current };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const p = pinch.current;
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, p.start.scale * (dist / p.dist)));
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const z = zoomAt(p.start, next, p.mid.x, p.mid.y);
      // The fingers may also travel together: follow them.
      setZoom({ ...z, x: z.x + (mid.x - p.mid.x), y: z.y + (mid.y - p.mid.y) });
    } else if (pan.current && zoomRef.current.scale > 1) {
      const s = pan.current;
      setZoom({ ...s.start, x: s.start.x + (e.clientX - s.x), y: s.start.y + (e.clientY - s.y) });
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const startedAsTap =
      pointers.current.size === 1 &&
      !pinch.current &&
      pan.current != null &&
      Math.hypot(e.clientX - pan.current.x, e.clientY - pan.current.y) < 10;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 1) {
      // One finger left after a pinch: carry on as a pan from here.
      const [rest] = [...pointers.current.values()];
      pan.current = { x: rest.x, y: rest.y, start: zoomRef.current };
    } else if (pointers.current.size === 0) {
      pan.current = null;
      setTouching(false);
    }
    // A mouse gets the browser's own dblclick (onDoubleClick below); this
    // double-tap check is for fingers and pens.
    if (!startedAsTap || e.pointerType === "mouse") return;
    // Double tap: zoom in on the spot, or back out to 1×.
    const now = Date.now();
    const prev = lastTap.current;
    if (prev && now - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_PX) {
      lastTap.current = null;
      toggleAt(e.clientX, e.clientY);
    } else {
      lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    }
  };

  // Wheel and trackpad pinch (which arrives as a ctrl+wheel). Attached by hand
  // because React's onWheel is passive and cannot stop the page from zooming.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const z = zoomRef.current;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
      const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, z.scale * factor));
      const r = el.getBoundingClientRect();
      setZoom(zoomAt(z, next, e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom]);

  const toggleAt = (clientX: number, clientY: number) => {
    const z = zoomRef.current;
    if (z.scale > 1) setZoom(IDENTITY);
    else {
      const p = local(clientX, clientY);
      setZoom(zoomAt(z, DOUBLE_TAP_SCALE, p.x, p.y));
    }
  };

  const step = (factor: number) => {
    const z = zoomRef.current;
    setZoom(zoomAt(z, Math.min(MAX_SCALE, Math.max(MIN_SCALE, z.scale * factor)), 0, 0));
  };

  const zoomed = zoom.scale > 1;
  const BTN =
    "flex h-11 w-11 items-center justify-center rounded-full bg-black/55 text-lg font-semibold text-white backdrop-blur transition hover:bg-black/70 disabled:opacity-35";

  return (
    <div
      ref={box}
      className={`relative h-full w-full overflow-hidden select-none ${zoomed ? "cursor-grab" : "cursor-zoom-in"} ${className}`}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        toggleAt(e.clientX, e.clientY);
      }}
    >
      <div
        className="flex h-full w-full items-center justify-center"
        style={{
          transform: `translate3d(${zoom.x}px, ${zoom.y}px, 0) scale(${zoom.scale})`,
          transformOrigin: "50% 50%",
          transition: touching ? "none" : "transform 120ms ease-out",
          willChange: "transform",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={alt}
          onError={onError}
          draggable={false}
          className="pointer-events-none max-h-full max-w-full object-contain"
        />
      </div>
      <div className="absolute bottom-3 right-3 flex gap-2">
        <button type="button" className={BTN} aria-label="Zoom out" disabled={!zoomed} onClick={() => step(1 / 1.6)}>
          <span aria-hidden>{"−"}</span>
        </button>
        <button type="button" className={BTN} aria-label="Zoom in" disabled={zoom.scale >= MAX_SCALE} onClick={() => step(1.6)}>
          <span aria-hidden>+</span>
        </button>
        {zoomed ? (
          <button type="button" className={`${BTN} w-auto px-3 text-xs`} aria-label="Reset zoom" onClick={() => setZoom(IDENTITY)}>
            1×
          </button>
        ) : null}
      </div>
    </div>
  );
}
