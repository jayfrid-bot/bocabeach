import type { FlagColor } from "@/lib/types";

const FLAG_META: Record<
  FlagColor,
  { color: string; label: string; short: string; double?: boolean }
> = {
  green: { color: "#16a34a", label: "Low hazard", short: "Low" },
  yellow: { color: "#facc15", label: "Medium hazard", short: "Medium" },
  red: { color: "#dc2626", label: "High hazard", short: "High" },
  "double-red": { color: "#dc2626", label: "Water closed", short: "Closed", double: true },
  purple: { color: "#9333ea", label: "Dangerous marine life", short: "Marine life" },
  unknown: { color: "#64748b", label: "Unavailable", short: "No data" },
};

/**
 * A lifeguard warning flag rendered as the real thing: a square flag (two, for
 * double-red) flying on a pole, with its meaning beneath.
 *
 * `inline` swaps the flying-flag column for a slim swatch + label ROW, for
 * places where the flag is one line of a banner rather than a display graphic
 * (see SafetyBanner) — same swatch colors, a fraction of the height.
 */
export function LifeguardFlag({
  flag,
  inline = false,
  compact = false,
  swatchOnly = false,
}: {
  flag: FlagColor;
  inline?: boolean;
  /** Inline only: the short word ("Medium", "Marine life") so two flags fit
   *  on one line of the collapsed banner; the swatch color carries the rest
   *  and the aria-label/title keep the full meaning. */
  compact?: boolean;
  /** Inline only: the colored swatch without any word, for a collapsed line
   *  that already names another advisory — the aria-label/title still carry
   *  the full meaning and the expanded view spells it out. */
  swatchOnly?: boolean;
}) {
  const m = FLAG_META[flag];
  const patch = "block h-8 w-8 rounded-[2px] shadow-md ring-1 ring-black/30";

  if (inline) {
    const swatch = "block h-3.5 w-3 rounded-[2px] shadow-sm ring-1 ring-black/30";
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5"
        title={m.label}
        aria-label={`${flag.replace("-", " ")} flag — ${m.label}`}
      >
        <span className="flex shrink-0 gap-[2px]" aria-hidden>
          <span className={swatch} style={{ background: m.color }} />
          {m.double ? <span className={swatch} style={{ background: m.color }} /> : null}
        </span>
        {swatchOnly ? null : (
          <span className="truncate text-xs font-medium leading-none text-slate-700 dark:text-slate-300 sm:text-sm">
            {compact ? m.short : m.label}
          </span>
        )}
      </span>
    );
  }

  return (
    <div
      // w-24, not w-16: at 64px even "Low hazard" wrapped to two lines under the
      // flag, which read as a broken column next to the row's label.
      className="flex w-24 flex-col items-center gap-1"
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
      <span className="text-center text-xs font-medium leading-tight text-slate-700 dark:text-slate-300">
        {m.label}
      </span>
    </div>
  );
}
