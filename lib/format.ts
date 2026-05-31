// Presentation helpers (safe to import on the client).

export function fmtTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: tz,
  }).format(new Date(iso));
}

export function fmtRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const m = Math.round(diffMs / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Accent color for a 0-100 score. */
export function scoreColor(score: number): string {
  if (score >= 80) return "#34d399"; // emerald-400
  if (score >= 65) return "#a3e635"; // lime-400
  if (score >= 45) return "#fbbf24"; // amber-400
  return "#fb7185"; // rose-400
}
