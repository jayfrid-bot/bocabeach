"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { NerdInfo } from "@/lib/nerdInfo";

/**
 * Tracks the OS "reduce motion" setting on the client. Defaults to `false` on
 * the server / first paint so SSR and hydration agree (the card starts on its
 * front, which looks identical either way); the real value lands after mount,
 * which is always before any user-initiated flip. Used to swap the 3D spin for
 * a plain opacity crossfade for motion-sensitive users.
 */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/** The subtle "this card flips" affordance (front) — a quiet rotate glyph. */
function FlipGlyph({ back = false }: { back?: boolean }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute right-2.5 top-2.5 z-10 text-slate-400/80 dark:text-slate-500"
      title={back ? "Flip back" : "Flip for the data & math"}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {back ? (
          // "flip back" — undo-style arrow curving left
          <>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h11a5 5 0 0 1 0 10h-1" />
          </>
        ) : (
          // "flip" — two arrows chasing in a circle
          <>
            <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-6.7-3" />
            <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 6.7 3" />
            <path d="M21 3v5h-5" />
            <path d="M3 21v-5h5" />
          </>
        )}
      </svg>
    </span>
  );
}

/**
 * A reusable click-to-flip card. The FRONT keeps its exact look (the card you
 * pass as `front`) plus a small flip glyph; the BACK reveals `back`.
 *
 * Layout / no-jump: the front sits in normal flow and gives the card its height
 * (with a readable `minHeightRem` floor), and — because these live in a grid
 * with `items-stretch` + `h-full` faces — every card in a band shares the row's
 * height. The back is absolutely positioned over that same box and scrolls
 * internally when its content is taller, so flipping NEVER changes any height.
 *
 * Motion: a 3D rotateY spin by default; a plain opacity crossfade (no rotation)
 * when the OS asks to reduce motion. The app-wide reduced-motion rule in
 * globals.css already zeroes transition-duration, so even the spin path can't
 * animate for those users — but we swap the mechanism outright so there's no
 * transform to disable in the first place.
 */
export function FlipCard({
  label,
  front,
  back,
  minHeightRem = 11.5,
}: {
  /** Short name of the metric, woven into the aria-label. */
  label: string;
  front: ReactNode;
  back: ReactNode;
  /** Readable height floor (rem) so short fronts still give the back room. */
  minHeightRem?: number;
}) {
  const [flipped, setFlipped] = useState(false);
  const reduced = usePrefersReducedMotion();
  const spin = !reduced;

  const toggle = () => setFlipped((f) => !f);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={flipped}
      aria-label={
        flipped
          ? `Show the ${label} reading again`
          : `Flip the ${label} card for the data, math, and sources`
      }
      onClick={toggle}
      onKeyDown={onKeyDown}
      className="group relative h-full cursor-pointer rounded-2xl [perspective:1200px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ocean-500/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
      style={{ minHeight: `${minHeightRem}rem` }}
    >
      <div
        className={
          "relative h-full w-full " +
          (spin
            ? "transition-transform duration-[450ms] ease-out [transform-style:preserve-3d] motion-reduce:transition-none"
            : "")
        }
        style={spin ? { transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" } : undefined}
      >
        {/* FRONT — in normal flow, so it sets the card's height. */}
        <div
          aria-hidden={flipped}
          className={
            "relative h-full w-full " +
            (spin
              ? "[backface-visibility:hidden]"
              : "transition-opacity duration-200 " +
                (flipped ? "opacity-0 pointer-events-none" : "opacity-100"))
          }
        >
          {front}
          <FlipGlyph />
        </div>

        {/* BACK — absolutely overlaid on the same box; never affects sizing. */}
        <div
          aria-hidden={!flipped}
          className={
            "absolute inset-0 h-full w-full " +
            (spin
              ? "[transform:rotateY(180deg)] [backface-visibility:hidden]"
              : "transition-opacity duration-200 " +
                (flipped ? "opacity-100" : "opacity-0 pointer-events-none"))
          }
        >
          {back}
          <FlipGlyph back />
        </div>
      </div>
    </div>
  );
}

/**
 * The "data nerd" back face: how a card's number is computed, its weight in the
 * Beach Day score, the live math, the real sources, and any caveats. Styled to
 * match the card chrome so the flip reads as the same tile turning over. The
 * header stays put; the body scrolls internally when it's long.
 *
 * Back order (top → bottom): header → plain-English EXPLAINER → RIGHT NOW →
 * SOURCES → caveat notes → FORMULA (last, as a muted monospace footnote). The
 * explainer leads so the friendliest sentence is what you read first; the raw
 * formula is demoted to a footnote at the very bottom.
 */
export function NerdBack({ info }: { info: NerdInfo }) {
  const sectionLabel =
    "text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500";
  return (
    <div className="flex h-full w-full flex-col rounded-2xl bg-white/95 p-3.5 text-left ring-1 ring-slate-900/10 dark:bg-slate-900/90 dark:ring-white/10">
      <div className={`pr-5 ${sectionLabel}`}>How we compute this</div>
      <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-1 pr-5">
        <span className="text-[13px] font-semibold leading-tight text-slate-900 dark:text-white">
          {info.title}
        </span>
        {info.weightPct != null ? (
          <span className="rounded-full bg-ocean-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-ocean-700 ring-1 ring-ocean-500/20 dark:text-ocean-300">
            {info.weightPct}% of score
          </span>
        ) : (
          <span className="rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 ring-1 ring-slate-500/20 dark:text-slate-400">
            not scored
          </span>
        )}
      </div>

      <div className="mt-1.5 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 text-slate-600 dark:text-slate-300">
        {/* Plain-English lead — first thing you read. */}
        <p className="text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
          {info.explainer}
        </p>

        <section>
          <div className={sectionLabel}>Right now</div>
          <div className="mt-0.5 space-y-0.5 text-xs leading-snug">
            {info.computation.map((line, i) => (
              <div key={i}>{line}</div>
            ))}
          </div>
        </section>

        <section>
          <div className={sectionLabel}>Sources</div>
          <ul className="mt-0.5 space-y-0.5 text-[11px] leading-snug">
            {info.sources.map((s, i) => (
              <li key={i} className="flex gap-1.5">
                <span aria-hidden className="text-slate-400 dark:text-slate-500">
                  ·
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </section>

        {info.notes ? (
          <p className="text-[11px] italic leading-snug text-slate-500 dark:text-slate-400">
            {info.notes}
          </p>
        ) : null}

        {/* Formula last — a muted monospace footnote. */}
        <section className="border-t border-slate-200/70 pt-2 dark:border-white/10">
          <div className={sectionLabel}>Formula</div>
          <code className="mt-0.5 block whitespace-pre-wrap break-words font-mono text-[10px] leading-snug text-slate-500 dark:text-slate-400">
            {info.formula}
          </code>
        </section>
      </div>
    </div>
  );
}
