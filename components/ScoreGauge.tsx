import { clamp } from "@/lib/util";

export function ScoreGauge({
  score,
  rating,
  label,
  accent,
}: {
  score: number;
  rating: string;
  label: string;
  accent: string;
}) {
  const r = 80;
  const circ = 2 * Math.PI * r;
  const pct = clamp(score, 0, 100) / 100;
  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 200" className="h-48 w-48">
        <circle cx="100" cy="100" r={r} fill="none" stroke="#1e293b" strokeWidth="16" />
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
          fill="white"
          fontSize="52"
          fontWeight="700"
        >
          {score}
        </text>
        <text x="100" y="126" textAnchor="middle" fill="#94a3b8" fontSize="15">
          out of 100
        </text>
      </svg>
      <div className="mt-1 text-xl font-semibold" style={{ color: accent }}>
        {rating}
      </div>
      <div className="text-sm text-slate-400">{label}</div>
    </div>
  );
}
