import type { Wrapped, SunData } from "@/lib/types";
import { fmtTime } from "@/lib/format";

/** Daybreak (first light), sunrise and sunset for today, in local time. */
export function SunPanel({ sun, tz }: { sun: Wrapped<SunData>; tz: string }) {
  const d = sun.data;
  const rows = [
    { icon: "🌄", label: "Daybreak", iso: d?.daybreak, hint: "first light" },
    { icon: "🌅", label: "Sunrise", iso: d?.sunrise },
    { icon: "🌇", label: "Sunset", iso: d?.sunset },
  ];
  const any = rows.some((r) => r.iso);

  return (
    <div className="rounded-2xl bg-slate-900/70 p-4 ring-1 ring-white/10">
      <div className="flex items-center gap-2 text-sm text-slate-400">
        <span aria-hidden>☀️</span>
        <span>Sun</span>
      </div>
      {!any ? (
        <div className="mt-2 text-sm text-slate-500">Unavailable</div>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {rows.map((r) => (
            <li key={r.label} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-slate-300">
                <span aria-hidden>{r.icon}</span>
                {r.label}
                {r.hint ? (
                  <span className="text-xs text-slate-500">({r.hint})</span>
                ) : null}
              </span>
              <span className="text-white">{r.iso ? fmtTime(r.iso, tz) : "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
