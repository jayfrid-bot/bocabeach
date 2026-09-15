// Owner-only readout of QR-sticker scans (the scan_log table written by
// app/sticker/route.ts). Read-only and harmless, so it's exposed like the rest
// of the admin surface (see app/admin/yf/page.tsx). Returns per-source totals
// and a recent daily breakdown so the owner can tell which sticker placements
// actually get scanned.

import { getD1 } from "@/lib/db/d1Store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SourceRow {
  source: string;
  total: number;
  first_at: number;
  last_at: number;
}
interface DayRow {
  day: string;
  source: string;
  n: number;
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export async function GET(): Promise<Response> {
  const db = await getD1();
  if (!db) {
    return Response.json({ ok: false, reason: "no-db", bySource: [], recent: [], todayTotal: 0, total: 0 });
  }
  try {
    const bySource =
      (
        await db
          .prepare(
            `SELECT source, SUM(n) AS total, MIN(first_at) AS first_at, MAX(last_at) AS last_at
             FROM scan_log GROUP BY source ORDER BY total DESC`,
          )
          .all<SourceRow>()
      ).results ?? [];
    // Last 21 local days, newest first, so the console can show momentum.
    const recent =
      (
        await db
          .prepare(
            `SELECT day, source, n FROM scan_log
             WHERE day >= date('now','-21 days') ORDER BY day DESC, n DESC`,
          )
          .all<DayRow>()
      ).results ?? [];
    const t = today();
    const todayTotal = recent.filter((r) => r.day === t).reduce((a, r) => a + r.n, 0);
    const total = bySource.reduce((a, r) => a + r.total, 0);
    return Response.json({ ok: true, total, todayTotal, bySource, recent });
  } catch (e) {
    return Response.json({ ok: false, reason: String(e), bySource: [], recent: [], todayTotal: 0, total: 0 });
  }
}
