import type { SourceMeta } from "@/lib/types";
import { RelativeTime } from "@/components/RelativeTime";

const STATUS_COLOR: Record<string, string> = {
  ok: "#34d399",
  stale: "#fbbf24",
  "best-effort": "#60a5fa",
  error: "#fb7185",
};

export function SourceList({ sources }: { sources: SourceMeta[] }) {
  return (
    <div className="rounded-2xl bg-white/60 dark:bg-slate-900/50 p-4 ring-1 ring-slate-900/10 dark:ring-white/10">
      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">Data sources</h3>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {sources.map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-400">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: STATUS_COLOR[s.status] ?? "#64748b" }}
              title={s.status}
            />
            <span className="text-slate-700 dark:text-slate-300">{s.source}</span>
            <span className="text-slate-500">· <RelativeTime iso={s.fetchedAt} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}
