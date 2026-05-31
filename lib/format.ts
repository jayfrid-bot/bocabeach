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

/** Accent color for a 0-100 score, matching the dial thresholds (40/60/80). */
export function scoreColor(score: number): string {
  if (score >= 80) return "#06b6d4"; // epic
  if (score >= 60) return "#22c55e"; // good
  if (score >= 40) return "#f59e0b"; // fair
  return "#ef4444"; // poor
}
