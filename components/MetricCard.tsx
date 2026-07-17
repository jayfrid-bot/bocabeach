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
      <div className="mt-1 text-xl font-semibold text-slate-900 dark:text-white sm:text-2xl">{value}</div>
      {sub ? <div className="break-words text-xs text-slate-600 dark:text-slate-400 line-clamp-3">{sub}</div> : null}
    </div>
  );
}
