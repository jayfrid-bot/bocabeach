import type { SourceMeta } from "@/lib/types";
import { fmtRelative } from "@/lib/format";

const STATUS_COLOR: Record<string, string> = {
  ok: "#22c55e",
  stale: "#f59e0b",
  "best-effort": "#1b85f5",
  error: "#ef4444",
};

export function SourceList({ sources }: { sources: SourceMeta[] }) {
  return (
    <div
      className="rounded-md p-4"
      style={{
        background: "var(--paper-alt)",
        border: "1px solid color-mix(in srgb, var(--ink) 8%, transparent)",
      }}
    >
      <h3 className="font-head text-sm font-semibold uppercase tracking-[0.04em] text-ink-soft">
        Data sources
      </h3>
      <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
        {sources.map((s, i) => (
          <li key={i} className="flex items-center gap-2 text-xs text-ink-faint">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: STATUS_COLOR[s.status] ?? "#64748b" }}
              title={s.status}
            />
            <span className="text-ink-soft">{s.source}</span>
            <span className="text-ink-faint">· {fmtRelative(s.fetchedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
