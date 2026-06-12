import type { FlagColor } from "@/lib/types";

const FLAG_META: Record<
  FlagColor,
  { color: string; label: string; double?: boolean }
> = {
  green: { color: "#16a34a", label: "Low hazard" },
  yellow: { color: "#facc15", label: "Medium hazard" },
  red: { color: "#dc2626", label: "High hazard" },
  "double-red": { color: "#dc2626", label: "Water closed", double: true },
  purple: { color: "#9333ea", label: "Marine pests" },
  unknown: { color: "#64748b", label: "Unavailable" },
};

/**
 * A lifeguard warning flag rendered as the real thing: a square flag (two, for
 * double-red) flying on a pole, with its meaning beneath.
 */
export function LifeguardFlag({ flag }: { flag: FlagColor }) {
  const m = FLAG_META[flag];
  const patch = "block h-8 w-8 rounded-[2px] shadow-md ring-1 ring-black/30";
  return (
    <div
      className="flex w-16 flex-col items-center gap-1"
      title={m.label}
      aria-label={`${flag.replace("-", " ")} flag — ${m.label}`}
    >
      <div className="flex items-start gap-[3px]">
        <span
          className="h-9 w-[3px] rounded-full bg-gradient-to-b from-slate-300 to-slate-500"
          aria-hidden
        />
        <span className="flex gap-[3px]">
          <span className={patch} style={{ background: m.color }} />
          {m.double ? <span className={patch} style={{ background: m.color }} /> : null}
        </span>
      </div>
      <span className="text-center text-[10px] font-medium leading-tight text-slate-700 dark:text-slate-300">
        {m.label}
      </span>
    </div>
  );
}
