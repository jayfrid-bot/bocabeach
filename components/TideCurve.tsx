"use client";

import { useEffect, useState } from "react";
import type { TideEvent } from "@/lib/types";
import { fmtTime } from "@/lib/format";

// viewBox geometry.
const W = 320;
const H = 110;
const PX = 14; // horizontal padding
const PT = 22; // top padding (high-tide labels)
const PB = 24; // bottom padding (low-tide labels)

/**
 * The rise and fall of the tide as a smooth curve through the predicted
 * high/low events, with a marker showing where the current moment sits in the
 * cycle. Between consecutive events the water level follows roughly a cosine,
 * which is also how it's drawn here.
 *
 * The API only returns *upcoming* events, so the previous turning point is
 * mirrored from the next two (tides alternate with a near-constant interval)
 * to anchor the left edge of the curve at "now".
 */
export function TideCurve({ events, tz }: { events: TideEvent[]; tz: string }) {
  // Current time is client-only (set after mount) to keep SSR/hydration HTML
  // identical; refreshed each minute so the marker tracks long-lived tabs.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (events.length < 2) return null;

  const next = events.map((e) => ({ ...e, t: new Date(e.time).getTime() }));
  // Synthesized previous turning point: opposite type, one interval back,
  // height borrowed from the next event of that same type.
  const prev = {
    type: next[1].type,
    t: next[0].t - (next[1].t - next[0].t),
    heightFt: next[1].heightFt,
  };
  const pts = [prev, ...next];

  const t0 = pts[0].t;
  const tN = pts[pts.length - 1].t;
  const xFor = (t: number) => PX + ((t - t0) / (tN - t0)) * (W - 2 * PX);

  const hts = pts.map((p) => p.heightFt);
  const hLo = Math.min(...hts);
  const hHi = Math.max(...hts);
  const span = Math.max(hHi - hLo, 0.5);
  const yFor = (h: number) => PT + (1 - (h - hLo) / span) * (H - PT - PB);

  // Height at an arbitrary instant: cosine ease between bracketing events.
  const heightAt = (ms: number) => {
    const t = Math.max(t0, Math.min(tN, ms));
    for (let i = 0; i < pts.length - 1; i++) {
      if (t <= pts[i + 1].t) {
        const f = (t - pts[i].t) / (pts[i + 1].t - pts[i].t);
        const ease = (1 - Math.cos(Math.PI * f)) / 2;
        return pts[i].heightFt + ease * (pts[i + 1].heightFt - pts[i].heightFt);
      }
    }
    return pts[pts.length - 1].heightFt;
  };

  // Sample the cosine segments into one smooth path.
  const STEPS = 14;
  const d = pts
    .slice(0, -1)
    .flatMap((p, i) =>
      Array.from({ length: i === 0 ? STEPS + 1 : STEPS }, (_, k) => {
        const j = i === 0 ? k : k + 1;
        const t = p.t + (j / STEPS) * (pts[i + 1].t - p.t);
        return `${xFor(t).toFixed(1)} ${yFor(heightAt(t)).toFixed(1)}`;
      }),
    )
    .map((xy, i) => (i === 0 ? `M${xy}` : `L${xy}`))
    .join(" ");

  const nowVisible = now != null && now >= t0 && now <= tN;
  // The "now" word shares the chart's top band with the high-tide time labels,
  // so when the marker sits near a high tide (the most interesting moment!)
  // the two print on top of each other. Detect that and slide "now" to the
  // side of its dashed line, away from the colliding time label.
  const nowX = nowVisible ? xFor(now as number) : 0;
  const collidingHigh = nowVisible
    ? next.find((e) => e.type === "high" && Math.abs(xFor(e.t) - nowX) < 34)
    : undefined;
  const nowAnchor = collidingHigh
    ? xFor(collidingHigh.t) > nowX
      ? "end"
      : "start"
    : "middle";
  // Slide far enough to clear the time label itself (half a "12:57PM" plus
  // breathing room), not just the dashed line.
  const EVENT_HALF = 22;
  const nowTextX = collidingHigh
    ? xFor(collidingHigh.t) > nowX
      ? Math.min(nowX - 4, xFor(collidingHigh.t) - EVENT_HALF)
      : Math.max(nowX + 4, xFor(collidingHigh.t) + EVENT_HALF)
    : nowX;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 w-full" role="img" aria-label="Tide cycle">
      <defs>
        <linearGradient id="tide-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#32a4ff" stopOpacity="0.3" />
          <stop offset="100%" stopColor="#32a4ff" stopOpacity="0" />
        </linearGradient>
      </defs>

      <path d={`${d} L${W - PX} ${H - 6} L${PX} ${H - 6} Z`} fill="url(#tide-fill)" />
      <path d={d} fill="none" stroke="#32a4ff" strokeWidth="2" strokeLinecap="round" />

      {/* high/low turning points with time labels (upcoming events only) */}
      {next.map((e) => {
        const x = xFor(e.t);
        const y = yFor(e.heightFt);
        const above = e.type === "high";
        return (
          <g key={e.t}>
            <circle cx={x} cy={y} r="3" fill={above ? "#8ed8ff" : "#1758b6"} stroke="#0f172a" strokeWidth="1.5" />
            <text
              x={x}
              y={above ? y - 8 : y + 14}
              textAnchor="middle"
              className={above ? "fill-ocean-700 dark:fill-[#bce7ff]" : "fill-slate-500"}
              fontSize="8.5"
            >
              {fmtTime(e.time, tz).replace(" ", "")}
            </text>
          </g>
        );
      })}

      {/* "you are here" marker */}
      {nowVisible ? (
        <g>
          <line
            x1={xFor(now)}
            x2={xFor(now)}
            y1={PT - 10}
            y2={H - 6}
            stroke="#fbbf24"
            strokeWidth="1.2"
            strokeDasharray="2 3"
          />
          <circle
            cx={xFor(now)}
            cy={yFor(heightAt(now))}
            r="4.5"
            fill="#fbbf24"
            stroke="#0f172a"
            strokeWidth="2"
          />
          <text
            x={nowTextX}
            y={PT - 13}
            textAnchor={nowAnchor}
            fill="#fbbf24"
            fontSize="8.5"
            fontWeight="600"
          >
            now
          </text>
        </g>
      ) : null}
    </svg>
  );
}
