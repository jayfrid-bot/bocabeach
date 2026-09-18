// Owner-only readout of the sticker funnel. Read-only and harmless, so it's
// exposed like the rest of the admin surface (see app/admin/yf/page.tsx).
//
// Returns the whole chain, so the owner can tell a placement that gets scanned
// from a placement that gets installs:
//   scans   — scan_log, per source, plus a recent daily breakdown
//   taps    — scan_tap, per source: they tapped "Get the app"
//   attributed — install_attrib: installs credited to a scan. A MATCH, not a
//   fact — see lib/db/scanFunnel.ts for what it can and cannot tell you.

import { getD1 } from "@/lib/db/d1Store";
import { readFunnel } from "@/lib/db/scanFunnel";

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
    return Response.json({
      ok: false, reason: "no-db", bySource: [], recent: [], todayTotal: 0, total: 0,
      taps: [], tapsTotal: 0, attributed: [], attributedTotal: 0,
    });
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
    const { taps, installs } = await readFunnel(db);
    return Response.json({
      ok: true, total, todayTotal, bySource, recent,
      taps, tapsTotal: taps.reduce((a, r) => a + r.total, 0),
      attributed: installs, attributedTotal: installs.reduce((a, r) => a + r.total, 0),
    });
  } catch (e) {
    return Response.json({
      ok: false, reason: String(e), bySource: [], recent: [], todayTotal: 0, total: 0,
      taps: [], tapsTotal: 0, attributed: [], attributedTotal: 0,
    });
  }
}
