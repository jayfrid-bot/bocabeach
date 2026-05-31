import type { Wrapped, TideData } from "@/lib/types";
import { fmtTime } from "@/lib/format";
import { Surface } from "@/components/ui";

/** Smooth tide-curve sparkline built from the upcoming event heights. */
function TideCurve({ points, height = 56 }: { points: number[]; height?: number }) {
  if (points.length < 2) return null;
  const w = 280;
  const pad = 6;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (w - pad * 2));
  const norm = (v: number) =>
    height - pad - ((v - min) / (max - min || 1)) * (height - pad * 2);

  // Smooth via a Catmull-Rom -> cubic-bezier conversion.
  const pts = xs.map((x, i) => [x, norm(points[i])] as const);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  const area = `${d} L ${pts[pts.length - 1][0]} ${height} L ${pts[0][0]} ${height} Z`;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className="mt-3 block"
      aria-hidden
    >
      <path d={area} fill="color-mix(in srgb, var(--sea) 12%, transparent)" />
      <path
        d={d}
        fill="none"
        stroke="var(--sea)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TidePanel({ tides, tz }: { tides: Wrapped<TideData>; tz: string }) {
  const events = tides.data?.next ?? [];
  const heights = events.map((e) => e.heightFt);
  return (
    <Surface className="p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-head text-sm font-semibold uppercase tracking-[0.04em] text-ink-soft">
          <span aria-hidden>🌊</span>
          <span>Tides</span>
        </div>
        {tides.data?.trend ? (
          <span className="text-xs font-semibold text-sea-deep">
            {tides.data.trend === "rising" ? "↑ rising" : "↓ falling"}
          </span>
        ) : null}
      </div>

      {events.length === 0 ? (
        <div className="mt-2 text-sm text-ink-faint">Unavailable</div>
      ) : (
        <>
          <TideCurve points={heights} />
          <ul className="mt-2 space-y-1.5">
            {events.map((e, i) => (
              <li key={i} className="flex items-center justify-between text-sm">
                <span className="capitalize text-ink-soft">
                  {e.type === "high" ? "High" : "Low"} tide
                </span>
                <span className="font-semibold text-ink">{fmtTime(e.time, tz)}</span>
                <span className="w-12 text-right text-ink-faint">{e.heightFt} ft</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Surface>
  );
}
