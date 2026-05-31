import type { CityOfficialData, FlagColor, Wrapped } from "@/lib/types";

const FLAG_STYLE: Record<FlagColor, { bg: string; label: string }> = {
  green: { bg: "#16a34a", label: "Green — low hazard" },
  yellow: { bg: "#eab308", label: "Yellow — moderate surf/currents" },
  red: { bg: "#dc2626", label: "Red — high hazard" },
  "double-red": { bg: "#7f1d1d", label: "Double Red — water closed" },
  purple: { bg: "#9333ea", label: "Purple — dangerous marine life" },
  unknown: { bg: "#64748b", label: "Flag status unavailable" },
};

export function SafetyBanner({ city }: { city: Wrapped<CityOfficialData> }) {
  const data = city.data;
  if (!data) return null;
  const flags = data.flags.filter((f) => f !== "unknown");
  const hasWarning = flags.some((f) => ["red", "double-red", "purple"].includes(f));

  if (flags.length === 0 && (data.hazards?.length ?? 0) === 0) return null;

  return (
    <div
      className="rounded-md p-4"
      style={
        hasWarning
          ? {
              background: "color-mix(in srgb, var(--coral) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--coral) 40%, transparent)",
            }
          : {
              background: "var(--foam)",
              border: "1px solid color-mix(in srgb, var(--ink) 8%, transparent)",
            }
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-head text-sm font-semibold uppercase tracking-[0.04em] text-ink-soft">
          Lifeguard flags:
        </span>
        {flags.length === 0 ? (
          <span className="text-sm text-ink-faint">none reported</span>
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

      {data.marineLife?.length || data.hazards?.length ? (
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-soft">
          {data.marineLife?.length ? <span>🪼 {data.marineLife.join(", ")}</span> : null}
          {data.hazards?.length ? <span>⚠ {data.hazards.join(", ")}</span> : null}
        </div>
      ) : null}

      <div className="mt-2 text-xs text-ink-faint">
        Official report from {city.attribution}. Always heed posted signs and lifeguards.
      </div>
    </div>
  );
}
