export function MetricCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="flex h-full flex-col rounded-2xl bg-white/80 dark:bg-slate-900/70 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
        <span aria-hidden>{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      {/* The FlipCard floor makes reading tiles roughly square; centering the
          value block turns that extra room into a deliberate widget look
          instead of a top-heavy card with dead space at the bottom. */}
      <div className="flex flex-1 flex-col justify-center">
        <div className="text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">{value}</div>
        {/* Always reserve the sub line so values share a baseline across a row
            (a sub-less "27%" used to sit lower than its neighbor's "36%"). */}
        <div className="min-h-4 break-words text-xs text-slate-600 dark:text-slate-400 line-clamp-3">
          {sub ?? " "}
        </div>
      </div>
    </div>
  );
}
