import { Surface } from "@/components/ui";

/** A labeled metric tile (the "StatTile" of the Tower design). */
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
    <Surface className="p-3.5">
      <div className="flex items-center gap-2 text-ink-soft">
        <span className="text-lg" aria-hidden>
          {icon}
        </span>
        <span className="truncate font-head text-xs font-semibold uppercase tracking-[0.04em]">
          {label}
        </span>
      </div>
      <div className="mt-2 font-head text-2xl font-bold text-ink sm:text-3xl">{value}</div>
      {sub ? <div className="mt-0.5 break-words text-xs text-ink-faint">{sub}</div> : null}
    </Surface>
  );
}
