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
/** The least a picture may be allowed to zoom, however small it is. */
export const MIN_MAX_SCALE = 2;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_PX = 30;
const TAP_SLOP_PX = 10;

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export const IDENTITY: ZoomState = { scale: 1, x: 0, y: 0 };

/** The size an image of `nw`×`nh` is drawn at when fitted ("contain") into a
 *  `w`×`h` box. Unknown image size → the box itself. */
export function fittedSize(w: number, h: number, nw?: number, nh?: number): { fw: number; fh: number } {
  if (!nw || !nh || !w || !h) return { fw: w, fh: h };
  const s = Math.min(w / nw, h / nh);
  return { fw: nw * s, fh: nh * s };
}

/** Keep the zoomed picture on screen. The picture is drawn `fw`×`fh` (centred
 *  in a `w`×`h` box) and scaled by z.scale about the box centre, so along each
 *  axis it may slide until its edge meets the box edge, and not at all while
 *  it is still narrower than the box. */
export function clampZoom(z: ZoomState, w: number, h: number, fw = w, fh = h, max = MAX_SCALE): ZoomState {
  const scale = Math.min(max, Math.max(MIN_SCALE, z.scale));
  if (scale === 1) return IDENTITY;
  const mx = Math.max(0, (fw * scale - w) / 2);
  const my = Math.max(0, (fh * scale - h) / 2);
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

const clampScale = (s: number, max = MAX_SCALE) => Math.min(max, Math.max(MIN_SCALE, s));

/**
 * How far this picture may zoom: twice the zoom at which one picture pixel fills one screen
 * pixel, never under MIN_MAX_SCALE or over MAX_SCALE. Past that the picture only shows blocks.
 * A 1280 px still on a 390 px phone (3 screen pixels per point) is 1.1x real, so 2.2x; a 1920 px
 * still 3.3x; a 4352 px original reaches the 5x limit. Unknown picture size: MAX_SCALE.
 */
export function maxScaleFor(naturalWidth: number | undefined, fittedWidthCss: number, dpr: number): number {
  if (!naturalWidth || !fittedWidthCss) return MAX_SCALE;
  const real = naturalWidth / (fittedWidthCss * Math.max(1, dpr || 1));
  return Math.min(MAX_SCALE, Math.max(MIN_MAX_SCALE, 2 * real));
}

/** The largest original (in pixels) any device is asked to decode: 20 megapixels. */
export const ORIGINAL_MAX_PIXELS = 20_000_000;
/** On a touch or narrow screen the limit is lower, to protect older phones (12 MP is about 48 MB decoded). */
export const ORIGINAL_MAX_PIXELS_SMALL_SCREEN = 12_000_000;

/**
 * Whether the viewer may swap in an original of `width` x `height`. No when the visitor asked
 * to save data, when the original is over 20 MP, or when the screen is touch or narrow and the
 * original is over 12 MP.
 */
export function originalAllowed(o: { width: number; height: number; smallScreen: boolean; saveData: boolean }): boolean {
  if (o.saveData) return false;
  const pixels = o.width * o.height;
  if (!(pixels > 0) || pixels > ORIGINAL_MAX_PIXELS) return false;
  return !(o.smallScreen && pixels > ORIGINAL_MAX_PIXELS_SMALL_SCREEN);
}

/** "6000x4000" to its two numbers; null for anything else. */
export function parseSizeHeader(v: string | null): { width: number; height: number } | null {
  const m = /^(\d{1,5})x(\d{1,5})$/.exec(v ?? "");
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

export function ZoomableImage({
  src,
  sharpSrc,
  alt,
  onError,
  onZoomedChange,
  className = "",
}: {
  src: string;
  /** A sharper copy of the same picture (same shape, more pixels). It is fetched only once the
   *  viewer first zooms in, and swapped in without resetting the zoom when it has loaded. If it
   *  fails to load, the normal picture stays. */
  sharpSrc?: string;
  alt: string;
  onError?: () => void;
  /** Tells the parent when the picture leaves or returns to 1×, e.g. to pause
   *  swipe or arrow-key navigation while the viewer is zoomed. */
  onZoomedChange?: (zoomed: boolean) => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const img = useRef<HTMLImageElement | null>(null);
  const [zoom, setZoomState] = useState<ZoomState>(IDENTITY);
  // True while a finger or the mouse is down: the picture then follows it with no easing.
  const [touching, setTouching] = useState(false);
  const zoomRef = useRef<ZoomState>(IDENTITY);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; start: ZoomState; mid: { x: number; y: number } } | null>(null);
  const pan = useRef<{ x: number; y: number; start: ZoomState } | null>(null);
  /** The touch that may become a tap: one finger, down and up without moving. */
  const tapCandidate = useRef<{ id: number; x: number; y: number } | null>(null);
  /** Set once two fingers were down; cleared when every finger is up. A finger
   *  lifting after a pinch is never a tap. */
  const gestured = useRef(false);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  /** The browser's dblclick carries no pointer type, so remember the last one. */
  const lastPointerType = useRef<string>("mouse");
  const zoomedCb = useRef(onZoomedChange);
  useEffect(() => {
    zoomedCb.current = onZoomedChange;
  });

  /** The most this picture may zoom now (see maxScaleFor); MAX_SCALE until the picture has loaded. */
  const currentMax = useCallback((): number => {
    const el = box.current;
    const nw = img.current?.naturalWidth;
    if (!el || !nw) return MAX_SCALE;
    const { fw } = fittedSize(el.clientWidth, el.clientHeight, nw, img.current?.naturalHeight);
    return maxScaleFor(nw, fw, typeof window === "undefined" ? 1 : window.devicePixelRatio);
  }, []);
  const [maxScale, setMaxScale] = useState(MAX_SCALE);

  const setZoom = useCallback((next: ZoomState) => {
    const el = box.current;
    let clamped = next;
    if (el) {
      const { fw, fh } = fittedSize(el.clientWidth, el.clientHeight, img.current?.naturalWidth, img.current?.naturalHeight);
      clamped = clampZoom(next, el.clientWidth, el.clientHeight, fw, fh, currentMax());
    }
    const wasZoomed = zoomRef.current.scale > 1;
    zoomRef.current = clamped;
    setZoomState(clamped);
    if (wasZoomed !== clamped.scale > 1) zoomedCb.current?.(clamped.scale > 1);
  }, [currentMax]);

  // A new picture starts at 1×.
  useEffect(() => {
    setZoom(IDENTITY);
  }, [src, setZoom]);

  // The sharp copy: wanted from the first zoom on, shown once it has fully loaded. `src` is
  // not changed, so the zoom the viewer set stays where it is.
  const [shown, setShown] = useState(src);
  const [wantSharp, setWantSharp] = useState(false);
  useEffect(() => {
    setShown(src);
    setWantSharp(false);
  }, [src]);
  const zoomedIn = zoom.scale > 1;
  useEffect(() => {
    if (zoomedIn) setWantSharp(true);
  }, [zoomedIn]);
  useEffect(() => {
    if (!sharpSrc || !wantSharp) return;
    let live = true;
    let objectUrl: string | null = null;
    const abort = new AbortController();
    const keepNormal = () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    };
    (async () => {
      const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
      const smallScreen =
        window.matchMedia?.("(pointer: coarse)").matches === true || window.innerWidth < 768;
      // Saving data: never ask for the original.
      if (nav.connection?.saveData) return;
      // One download, held as a blob (a plain <img> could fetch it a second time).
      const res = await fetch(sharpSrc, { signal: abort.signal });
      // Only a real original counts: the server may answer with the normal still (over its
      // limit), or 404/409 (no original, or a newer frame than the one shown).
      if (!res.ok || res.headers.get("X-Cam-Original") !== "1") return;
      // The size comes in a header, so a picture too big for this device is refused before its body is read.
      const size = parseSizeHeader(res.headers.get("X-Cam-Original-Size"));
      if (!size || !originalAllowed({ ...size, smallScreen, saveData: false })) {
        abort.abort();
        return;
      }
      const blob = await res.blob();
      if (!live || !blob.type.startsWith("image/")) return;
      objectUrl = URL.createObjectURL(blob);
      // Decode off screen first. Swap only when it decoded; on any failure the normal picture stays.
      const probe = new Image();
      probe.src = objectUrl;
      await probe.decode();
      if (!live) return;
      setShown(objectUrl);
    })().catch(keepNormal);
    return () => {
      live = false;
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sharpSrc, wantSharp]);

  /** A point relative to the box centre. */
  const local = (clientX: number, clientY: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  };

  /** Start the gesture over from the fingers down now: a pinch from the first
   *  two, or a pan from the only one. Called whenever a finger lands or lifts,
   *  so a third finger, or one finger left after a pinch, never makes a jump. */
  const restartGesture = () => {
    const pts = [...pointers.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      pinch.current = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        start: zoomRef.current,
        mid: local((a.x + b.x) / 2, (a.y + b.y) / 2),
      };
      pan.current = null;
    } else if (pts.length === 1) {
      pinch.current = null;
      pan.current = { x: pts[0].x, y: pts[0].y, start: zoomRef.current };
    } else {
      pinch.current = null;
      pan.current = null;
    }
  };

  const toggleAt = (clientX: number, clientY: number) => {
    const z = zoomRef.current;
    if (z.scale > 1) setZoom(IDENTITY);
    else {
      const p = local(clientX, clientY);
      setZoom(zoomAt(z, Math.min(DOUBLE_TAP_SCALE, currentMax()), p.x, p.y));
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Buttons inside the box keep their own clicks.
    if ((e.target as HTMLElement).closest("button")) return;
    lastPointerType.current = e.pointerType;
    try {
      box.current?.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks cannot be captured; moves still arrive.
    }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    setTouching(true);
    if (pointers.current.size >= 2) gestured.current = true;
    tapCandidate.current =
      pointers.current.size === 1 && !gestured.current ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
    restartGesture();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const tc = tapCandidate.current;
    if (tc && tc.id === e.pointerId && Math.hypot(e.clientX - tc.x, e.clientY - tc.y) > TAP_SLOP_PX) {
      tapCandidate.current = null;
    }
    if (pinch.current && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const p = pinch.current;
      const next = clampScale(p.start.scale * (dist / p.dist), currentMax());
      const mid = local((a.x + b.x) / 2, (a.y + b.y) / 2);
      const z = zoomAt(p.start, next, p.mid.x, p.mid.y);
      // The fingers may also travel together: follow them.
      setZoom({ ...z, x: z.x + (mid.x - p.mid.x), y: z.y + (mid.y - p.mid.y) });
    } else if (pan.current && zoomRef.current.scale > 1) {
      const s = pan.current;
      setZoom({ ...s.start, x: s.start.x + (e.clientX - s.x), y: s.start.y + (e.clientY - s.y) });
    }
  };

  /** A finger lifted (`tap` true) or the browser took the touch away (false). */
  const release = (e: React.PointerEvent<HTMLDivElement>, canTap: boolean) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.delete(e.pointerId);
    const tc = tapCandidate.current;
    const isTap = canTap && tc != null && tc.id === e.pointerId && !gestured.current && e.pointerType !== "mouse";
    tapCandidate.current = null;
    if (pointers.current.size === 0) {
      gestured.current = false;
      setTouching(false);
    }
    restartGesture();
    if (!isTap) return;
    // Double tap: zoom in on the spot, or back out to 1×. (A mouse uses the
    // browser's own dblclick, below.)
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
      const r = el.getBoundingClientRect();
      setZoom(zoomAt(z, clampScale(z.scale * factor, currentMax()), e.clientX - r.left - r.width / 2, e.clientY - r.top - r.height / 2));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setZoom, currentMax]);

  const step = (factor: number) => {
    const z = zoomRef.current;
    setZoom(zoomAt(z, clampScale(z.scale * factor, currentMax()), 0, 0));
  };

  const zoomed = zoom.scale > 1;
  const BTN =
    "flex h-11 min-w-[44px] items-center justify-center rounded-full bg-black/55 px-3 text-lg font-semibold text-white backdrop-blur transition hover:bg-black/70 disabled:opacity-35";

  return (
    <div
      ref={box}
      className={`relative h-full w-full overflow-hidden select-none ${zoomed ? "cursor-grab" : "cursor-zoom-in"} ${className}`}
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => release(e, true)}
      onPointerCancel={(e) => release(e, false)}
      onDoubleClick={(e) => {
        // Touch double-taps also fire dblclick; those were handled on pointerup.
        if (lastPointerType.current !== "mouse") return;
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
          ref={img}
          src={shown}
          alt={alt}
          onError={onError}
          onLoad={() => setMaxScale(currentMax())}
          draggable={false}
          className="pointer-events-none h-full w-full object-contain"
        />
      </div>
      <div className="absolute bottom-3 right-3 flex gap-2">
        <button type="button" className={BTN} aria-label="Zoom out" disabled={!zoomed} onClick={() => step(1 / 1.6)}>
          <span aria-hidden>{"−"}</span>
        </button>
        <button type="button" className={BTN} aria-label="Zoom in" disabled={zoom.scale >= maxScale - 0.001} onClick={() => step(1.6)}>
          <span aria-hidden>+</span>
        </button>
        {zoomed ? (
          <button type="button" className={`${BTN} text-xs`} aria-label="Reset zoom" onClick={() => setZoom(IDENTITY)}>
            1×
          </button>
        ) : null}
      </div>
    </div>
  );
}
