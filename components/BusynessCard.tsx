import type { BusynessData } from "@/lib/types";
import { BUSYNESS_SLOTS, busynessFilledSlots } from "@/lib/busynessFill";

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** One umbrella-and-pole silhouette, filled/ghosted/dimmed per its slot state. */
function Umbrella({ state }: { state: "filled" | "ghost" | "dimmed" }) {
  const opacity = state === "filled" ? 1 : state === "ghost" ? 0.28 : 0.16;
  const fill = state === "filled" ? "#146de1" : "currentColor"; // ocean-700 when filled
  return (
    <svg viewBox="0 0 24 30" className="h-5 w-5 sm:h-6 sm:w-6" aria-hidden>
      <path
        d="M12 2C6.5 2 2 6.6 2 11.8h20C22 6.6 17.5 2 12 2Z"
        fill={fill}
        opacity={opacity}
      />
      <rect x="11" y="11.5" width="2" height="16.5" rx="1" fill={fill} opacity={opacity} />
    </svg>
  );
}

/**
 * Beach busyness card: a sand-colored strip of ~10 umbrella silhouettes, N of
 * them filled in for the current crowd %. Honors the honest gating from
 * lib/sources/busyness.ts — when the cams can't read the beach right now
 * (night, or a stale capture), the strip renders an explicit "unknown" state
 * with the note instead of quietly showing an empty-looking beach (which at
 * night would be a lie, not a reading). Renders nothing when this beach has
 * no busyness source at all (no cams).
 */
export function BusynessCard({ busy }: { busy?: BusynessData | null }) {
  if (!busy) return null;
  const isUnknown = busy.level === "unknown";
  // Matches the old MetricCard's gate: an unknown level with no note at all
  // means there's nothing worth showing (not even a "why"), so hide the card.
  if (isUnknown && !busy.note) return null;

  if (isUnknown) {
    return (
      <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <span aria-hidden>👥</span>
          <span>Beach busyness</span>
        </div>
        <div className="mt-1 text-xl font-semibold text-slate-500 dark:text-slate-400 sm:text-2xl">
          Unknown right now
        </div>
        <div className="mt-2 flex flex-wrap gap-1 rounded-xl bg-slate-100/80 p-2 text-slate-400 dark:bg-slate-950/40 dark:text-slate-600">
          {Array.from({ length: BUSYNESS_SLOTS }, (_, i) => (
            <Umbrella key={i} state="dimmed" />
          ))}
        </div>
        <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-400">
          <span aria-hidden>🌙</span>
          <span>{busy.note}</span>
        </div>
      </div>
    );
  }

  const filled = busynessFilledSlots(busy.crowdPct, busy.level);
  const pct = Math.round((filled / BUSYNESS_SLOTS) * 100);
  const sub = [
    busy.peopleEstimate != null ? `~${busy.peopleEstimate} people` : undefined,
    busy.crowdPct != null ? `~${busy.crowdPct}% full` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>👥</span>
        <span>Beach busyness</span>
      </div>
      <div className="mt-1 text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
        {cap(busy.level)}
      </div>
      <div className="mt-2 flex flex-wrap gap-1 rounded-xl bg-amber-100/70 p-2 dark:bg-slate-950/30">
        {Array.from({ length: BUSYNESS_SLOTS }, (_, i) => (
          <Umbrella key={i} state={i < filled ? "filled" : "ghost"} />
        ))}
      </div>
      <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
        {filled} of {BUSYNESS_SLOTS} filled = {pct}% full
        {sub ? ` · ${sub}` : ""}
      </div>
    </div>
  );
}
