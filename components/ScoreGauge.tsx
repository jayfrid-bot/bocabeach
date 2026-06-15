import { scoreTextClass } from "@/lib/format";
import { clamp } from "@/lib/util";

export function ScoreGauge({
  score,
  rating,
  accent,
}: {
  score: number;
  rating: string;
  /** Caption under the gauge — no longer rendered (dashboard headline names it); kept for caller compatibility. */
  label?: string;
  accent: string;
}) {
  const r = 80;
  const circ = 2 * Math.PI * r;
  const pct = clamp(score, 0, 100) / 100;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 200" className="h-48 w-48">
        <circle cx="100" cy="100" r={r} fill="none" className="stroke-slate-200 dark:stroke-slate-800" strokeWidth="16" />
        <circle
          cx="100"
          cy="100"
          r={r}
          fill="none"
          stroke={accent}
          strokeWidth="16"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - pct)}
          transform="rotate(-90 100 100)"
          style={{ transition: "stroke-dashoffset 600ms ease, stroke 300ms ease" }}
        />
        <text
          x="100"
          y="96"
          textAnchor="middle"
          className="fill-slate-900 dark:fill-white"
          fontSize="52"
          fontWeight="700"
        >
          {score}
        </text>
        <text x="100" y="126" textAnchor="middle" className="fill-slate-500 dark:fill-slate-400" fontSize="15">
          out of 100
        </text>
      </svg>
      <div className={`mt-1 text-xl font-semibold ${scoreTextClass(score)}`}>
        {rating}
      </div>
    </div>
  );
}
