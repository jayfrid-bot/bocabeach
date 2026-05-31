"use client";

import { useEffect, useRef, useState } from "react";

const SIZE = 300;
const CX = SIZE / 2;
const CY = SIZE / 2;
const R = 140;
const TRACK = 14;
const START = 135; // 270° sweep from 135° to 405°, 90° gap at the bottom
const SWEEP = 270;
const NEEDLE_LEN = 120;
const TICKS = 28;
const MAJOR_EVERY = Math.round((TICKS - 1) / 5); // majors at 0/5/10/15/20/25

function arc(deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [CX + R * Math.cos(a), CY + R * Math.sin(a)];
}
const polar = (frac: number) => START + SWEEP * frac;

/** Score -> nautical color var, thresholds at 40/60/80. */
function scoreVar(score: number): string {
  if (score >= 80) return "var(--score-epic)";
  if (score >= 60) return "var(--score-good)";
  if (score >= 40) return "var(--score-fair)";
  return "var(--score-poor)";
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/** Count-up the displayed number from its previous value to `target`. */
function useCountUp(target: number, durationMs = 650): number {
  const [value, setValue] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setValue(target);
      fromRef.current = target;
      return;
    }
    const from = fromRef.current;
    if (from === target) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, durationMs]);
  return value;
}

/**
 * 270° instrument dial for the Beach Day score (135° -> 405°, 90° gap at the
 * bottom). On each refresh (`pulseToken` change) the needle eases to the new
 * angle, a tick ripple sweeps the track, the hub pings, and the number counts
 * up — all gated on prefers-reduced-motion (global CSS rule + JS guard).
 */
export function TowerDial({
  score,
  rating,
  pulseToken,
}: {
  score: number;
  rating: string;
  pulseToken?: string;
}) {
  const clamped = Math.max(0, Math.min(100, score));
  const frac = clamped / 100;
  const needleDeg = polar(frac);
  const color = scoreVar(clamped);
  const display = useCountUp(clamped);

  // Re-mount the ripple/ping elements on each refresh to retrigger the CSS anim.
  const [pulse, setPulse] = useState(0);
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return; // skip the very first paint
    }
    setPulse((p) => p + 1);
  }, [pulseToken]);

  const [sx, sy] = arc(START);
  const [ex, ey] = arc(START + SWEEP);
  const trackPath = `M ${sx} ${sy} A ${R} ${R} 0 1 1 ${ex} ${ey}`;
  const [fx, fy] = arc(needleDeg);
  const fillBig = SWEEP * frac > 180 ? 1 : 0;
  const fillPath = `M ${sx} ${sy} A ${R} ${R} 0 ${fillBig} 1 ${fx} ${fy}`;

  return (
    <div
      className="relative"
      style={{ width: SIZE, maxWidth: "100%", aspectRatio: "1 / 1" }}
      role="img"
      aria-label={`Beach Day score ${clamped} out of 100, rated ${rating}`}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        style={{ overflow: "visible" }}
      >
        <path
          d={trackPath}
          fill="none"
          stroke="var(--dial-track)"
          strokeWidth={TRACK}
          strokeLinecap="round"
        />

        {pulse > 0 ? (
          <circle
            key={`ripple-${pulse}`}
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke={color}
            strokeWidth={TRACK}
            className="tower-ripple"
            style={{ transformOrigin: `${CX}px ${CY}px`, color }}
          />
        ) : null}

        {Array.from({ length: TICKS }, (_, i) => {
          const f = i / (TICKS - 1);
          const deg = polar(f);
          const [x1, y1] = arc(deg);
          const major = i % MAJOR_EVERY === 0;
          const inner = R - (major ? 22 : 12);
          const a = (deg * Math.PI) / 180;
          const x2 = CX + inner * Math.cos(a);
          const y2 = CY + inner * Math.sin(a);
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke={major ? "var(--dial-tick-major)" : "var(--dial-tick)"}
              strokeWidth={major ? 3 : 1.5}
              strokeLinecap="round"
            />
          );
        })}

        <path
          d={fillPath}
          fill="none"
          stroke={color}
          strokeWidth={TRACK}
          strokeLinecap="round"
          style={{
            color,
            filter:
              "drop-shadow(0 0 6px color-mix(in srgb, currentColor 50%, transparent))",
          }}
        />

        <g
          style={{
            transform: `rotate(${needleDeg}deg)`,
            transformOrigin: `${CX}px ${CY}px`,
            transition: "transform .9s cubic-bezier(.2,.7,.2,1)",
          }}
        >
          <line
            x1={CX}
            y1={CY}
            x2={CX + NEEDLE_LEN}
            y2={CY}
            stroke="var(--needle)"
            strokeWidth="4"
            strokeLinecap="round"
          />
        </g>

        {pulse > 0 ? (
          <circle
            key={`ping-${pulse}`}
            cx={CX}
            cy={CY}
            r="12"
            fill="none"
            stroke={color}
            strokeWidth="3"
            className="tower-ping"
            style={{ transformOrigin: `${CX}px ${CY}px`, color }}
          />
        ) : null}
        <circle cx={CX} cy={CY} r="12" fill="var(--hub)" />
      </svg>

      <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
        <div>
          <div
            key={`n-${display}`}
            className="tower-countup font-display leading-none text-ink"
            style={{ fontSize: 64 }}
          >
            {display}
          </div>
          <div className="font-head text-base uppercase tracking-[0.1em] text-ink-soft">
            {rating}
          </div>
        </div>
      </div>
    </div>
  );
}
