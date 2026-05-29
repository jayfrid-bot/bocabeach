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
    <div className="rounded-2xl bg-slate-900/70 p-4 ring-1 ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <span aria-hidden>{icon}</span>
        <span>{label}</span>
      </div>
      <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
      {sub ? <div className="text-xs text-slate-400">{sub}</div> : null}
    </div>
  );
}
