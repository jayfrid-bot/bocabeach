import type { CityOfficialData, FlagColor, Wrapped } from "@/lib/types";

const FLAG_STYLE: Record<FlagColor, { bg: string; label: string }> = {
  green: { bg: "#16a34a", label: "Green — low hazard" },
  yellow: { bg: "#eab308", label: "Yellow — moderate surf/currents" },
  red: { bg: "#dc2626", label: "Red — high hazard" },
  "double-red": { bg: "#7f1d1d", label: "Double Red — water closed" },
  purple: { bg: "#9333ea", label: "Purple — dangerous marine life" },
  unknown: { bg: "#475569", label: "Flag status unavailable" },
};

export function SafetyBanner({
  city,
}: {
  city: Wrapped<CityOfficialData>;
}) {
  const data = city.data;
  if (!data) return null;
  const flags = data.flags.filter((f) => f !== "unknown");
  const hasWarning = flags.some((f) =>
    ["red", "double-red", "purple"].includes(f),
  );

  if (flags.length === 0 && (data.hazards?.length ?? 0) === 0) return null;

  return (
    <div
      className={`rounded-2xl p-4 ring-1 ${
        hasWarning ? "bg-rose-500/10 ring-rose-500/40" : "bg-slate-900/70 ring-white/10"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-slate-200">
          Lifeguard flags:
        </span>
        {flags.length === 0 ? (
          <span className="text-sm text-slate-400">none reported</span>
        ) : (
          flags.map((f) => (
            <span
              key={f}
              className="rounded-full px-2.5 py-0.5 text-xs font-semibold text-white"
              style={{ background: FLAG_STYLE[f].bg }}
            >
              {FLAG_STYLE[f].label}
            </span>
          ))
        )}
      </div>

      {(data.marineLife?.length || data.hazards?.length) ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
          {data.marineLife?.length ? (
            <span>🪼 {data.marineLife.join(", ")}</span>
          ) : null}
          {data.hazards?.length ? <span>⚠ {data.hazards.join(", ")}</span> : null}
        </div>
      ) : null}

      <div className="mt-2 text-xs text-slate-500">
        Official report from {city.attribution}. Always heed posted signs and lifeguards.
      </div>
    </div>
  );
}
