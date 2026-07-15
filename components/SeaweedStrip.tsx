import type { SargassumData } from "@/lib/types";
import { clumpLayout, coveredCellIndices, SEAWEED_LEVEL_FALLBACK_PCT } from "@/lib/seaweedClumps";

const STRIP_W = 400;
const STRIP_H = 64;

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * Seaweed (sargassum) strip: a sand-colored band where brown/olive clumps
 * cover the same FRACTION of cells as the live sargassumCoveragePct — the
 * same number that drives the score's sliding ceiling (see applyBeachCaps in
 * lib/score.ts). Covered cells are spread across the full width (via
 * lib/seaweedClumps.ts's coveredCellIndices) rather than packed into the
 * leftmost X%, since a coverage % says nothing about WHERE on the beach it
 * is — only packing the clumps left would visually (and falsely) imply the
 * seaweed sits on one side. Clump shapes are deterministic (a fixed, seeded
 * layout) so SSR and the client render pixel-identical output; only which
 * cells are revealed changes with the coverage %. When only a category level
 * is known (no measured %), shows a representative coverage and says so.
 * Renders nothing without any seaweed data.
 */
export function SeaweedStrip({ seaweed }: { seaweed?: SargassumData | null }) {
  if (!seaweed || seaweed.level === "unknown") return null;

  const hasMeasured = typeof seaweed.coveragePct === "number" && Number.isFinite(seaweed.coveragePct);
  const coveragePct = hasMeasured
    ? (seaweed.coveragePct as number)
    : (SEAWEED_LEVEL_FALLBACK_PCT[seaweed.level] ?? 0);

  // Which cells are "covered" — spread across the full width at density
  // proportional to coveragePct, not packed into the leftmost X% (that would
  // imply a location we don't know; see lib/seaweedClumps.ts).
  const covered = new Set(coveredCellIndices(coveragePct));
  const shapes = clumpLayout().filter((s) => covered.has(s.index));

  return (
    <div className="rounded-2xl bg-white/80 p-4 ring-1 ring-slate-900/10 dark:bg-slate-900/70 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>🪸</span>
        <span>Seaweed (sargassum)</span>
      </div>
      <div className="mt-1 text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">
        {cap(seaweed.level)}
      </div>

      <div className="relative mt-2 h-14 w-full overflow-hidden rounded-xl bg-amber-100 dark:bg-amber-950/40 sm:h-16">
        <svg
          viewBox={`0 0 ${STRIP_W} ${STRIP_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          aria-hidden
        >
          {shapes.map((s) => (
            <ellipse
              key={s.index}
              cx={s.cx * STRIP_W}
              cy={s.cy * STRIP_H}
              rx={s.rx * STRIP_W}
              ry={s.ry * STRIP_H}
              fill={s.color}
              opacity={0.88}
              transform={`rotate(${s.rot} ${s.cx * STRIP_W} ${s.cy * STRIP_H})`}
            />
          ))}
        </svg>
      </div>

      <div className="mt-2 text-xs text-slate-600 dark:text-slate-400">
        {hasMeasured
          ? `~${Math.round(coveragePct)}% covered`
          : `~${Math.round(coveragePct)}% covered (approximate, from the ${seaweed.level} category)`}
        {seaweed.isMorning ? " · 📷 AM cams (pre-clean)" : " · 📷 cams"}
        {seaweed.note ? ` — ${seaweed.note}` : ""}
      </div>
    </div>
  );
}
