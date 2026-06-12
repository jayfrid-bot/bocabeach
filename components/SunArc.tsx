"use client";

import { useEffect, useState } from "react";
import type { SunData } from "@/lib/types";
import { fmtTime } from "@/lib/format";

// viewBox geometry.
const W = 320;
const H = 112;
const PX = 22;
const HORIZON_Y = 84;
const APEX_Y = 20;

/** Where the sun sits for daylight fraction f (0 = sunrise, 1 = sunset). */
function arcPoint(f: number) {
  return {
    x: PX + f * (W - 2 * PX),
    y: HORIZON_Y - Math.sin(Math.PI * Math.min(1, Math.max(0, f))) * (HORIZON_Y - APEX_Y),
  };
}

/** Plain-English label for where we are in the day. */
function dayPhase(f: number): string {
  if (f < 0.12) return "Early morning";
  if (f < 0.38) return "Morning";
  if (f < 0.45) return "Late morning";
  if (f < 0.58) return "Midday — peak sun";
  if (f < 0.8) return "Afternoon";
  if (f < 0.92) return "Late afternoon";
  return "Golden hour";
}

/**
 * The sun's pass across today's sky as an arc from sunrise to sunset, with the
 * sun drawn where we are right now and a plain-English phase label. Outside
 * daylight the sun sits below the horizon at the nearest edge.
 */
export function SunArc({ sun, tz }: { sun: SunData; tz: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  const rise = sun.sunrise ? new Date(sun.sunrise).getTime() : null;
  const set = sun.sunset ? new Date(sun.sunset).getTime() : null;
  if (rise == null || set == null || set <= rise) return null;

  // Daylight fraction; clamped slightly past the edges for the night state.
  const fRaw = now != null ? (now - rise) / (set - rise) : null;
  const daylight = fRaw != null && fRaw >= 0 && fRaw <= 1;
  const phase =
    fRaw == null ? null : daylight ? dayPhase(fRaw) : fRaw < 0 ? "Before sunrise" : "After sunset";

  // Sun position: on the arc during the day, just below the horizon at night.
  const sunPos =
    fRaw == null
      ? null
      : daylight
        ? arcPoint(fRaw)
        : { x: fRaw < 0 ? PX : W - PX, y: HORIZON_Y + 10 };

  // The arc itself, sampled.
  const STEPS = 28;
  const arc = Array.from({ length: STEPS + 1 }, (_, i) => {
    const p = arcPoint(i / STEPS);
    return `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }).join(" ");

  const noon = arcPoint(0.5);

  return (
    <div className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Sun's path across today">
        <defs>
          <radialGradient id="sunarc-glow" cx="0.5" cy="0.5" r="0.5">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="sunarc-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#1b85f5" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#1b85f5" stopOpacity="0" />
          </linearGradient>
        </defs>

        {/* sky under the arc + horizon */}
        <path d={`${arc} L${W - PX} ${HORIZON_Y} L${PX} ${HORIZON_Y} Z`} fill="url(#sunarc-sky)" />
        <path d={arc} fill="none" stroke="#475569" strokeWidth="1.5" strokeDasharray="3 4" />
        <line x1={8} y1={HORIZON_Y} x2={W - 8} y2={HORIZON_Y} stroke="#334155" strokeWidth="1.5" />

        {/* solar noon tick */}
        <line x1={noon.x} y1={APEX_Y - 6} x2={noon.x} y2={APEX_Y + 2} stroke="#64748b" strokeWidth="1" />
        {sun.solarNoon ? (
          <text x={noon.x} y={APEX_Y - 10} textAnchor="middle" className="fill-slate-600 dark:fill-slate-400" fontSize="9">
            peak {fmtTime(sun.solarNoon, tz)}
          </text>
        ) : null}

        {/* the sun, where we are right now */}
        {sunPos ? (
          <g>
            {daylight ? <circle cx={sunPos.x} cy={sunPos.y} r="16" fill="url(#sunarc-glow)" /> : null}
            <circle
              cx={sunPos.x}
              cy={sunPos.y}
              r="7"
              fill={daylight ? "#fbbf24" : "#475569"}
              stroke="#0f172a"
              strokeWidth="2"
            />
          </g>
        ) : null}

        {/* sunrise / sunset labels */}
        <text x={PX} y={HORIZON_Y + 16} textAnchor="start" className="fill-slate-600 dark:fill-slate-400" fontSize="9.5">
          🌅 {fmtTime(sun.sunrise!, tz)}
        </text>
        <text x={W - PX} y={HORIZON_Y + 16} textAnchor="end" className="fill-slate-600 dark:fill-slate-400" fontSize="9.5">
          {fmtTime(sun.sunset!, tz)} 🌇
        </text>

        {/* phase caption */}
        {phase ? (
          <text x={W / 2} y={HORIZON_Y + 16} textAnchor="middle" className="fill-slate-800 dark:fill-slate-200" fontSize="10" fontWeight="600">
            {phase}
          </text>
        ) : null}
      </svg>
    </div>
  );
}
