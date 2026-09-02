// The one-time reveal: the single day a free user sees their own number.
//
// After that the dashboard shows a locked pill instead, and this record is what
// lets the pill say something worth tapping — "On Sep 1 your score ran 13 points
// above everyone's" — without recomputing anything.

import type { PreviewRecord } from "@/lib/plus/types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The beach's local calendar day (YYYY-MM-DD) at `nowMs`. */
export function localDateKey(nowMs: number, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(nowMs));
  } catch {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
}

/** The reveal, ready to save. */
export function buildPreview(
  personal: number,
  everyone: number,
  label: string,
  nowMs: number,
  tz: string,
): PreviewRecord {
  return {
    date: localDateKey(nowMs, tz),
    personal: Math.round(personal),
    everyone: Math.round(everyone),
    label,
  };
}

/** "Sep 1" from a YYYY-MM-DD key. Parsed by hand — `new Date("2026-09-01")` is
 *  UTC midnight and can render as the day before west of Greenwich. */
export function formatPreviewDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${month} ${Number(m[3])}`;
}

/**
 * The reminder line under the locked pill. Null when there is nothing worth
 * saying (no saved reveal).
 */
export function previewReminder(preview: PreviewRecord | null): string | null {
  if (!preview) return null;
  const when = formatPreviewDate(preview.date);
  const delta = preview.personal - preview.everyone;
  if (delta === 0) return `On ${when} your score matched everyone's.`;
  const points = Math.abs(delta) === 1 ? "1 point" : `${Math.abs(delta)} points`;
  const dir = delta > 0 ? "above" : "below";
  return `On ${when} your score ran ${points} ${dir} everyone's.`;
}

/** The reveal headline: "Your score today 71 · Everyone's 58 · tuned for snorkeling". */
export function revealLine(personal: number, everyone: number, label: string): string {
  return `Your score today ${Math.round(personal)} · Everyone's ${Math.round(everyone)} · tuned for ${label}`;
}
