import { describe, it, expect } from "vitest";
import { LOCATIONS } from "@/config/locations";
import {
  NDBC_STATION_REPORTS_WAVES,
  reportsWaves,
  buoyCoverageViolations,
  type BuoyConfigured,
} from "./ndbcStations";

// The CI gate behind config/locations.ts's buoy assignments. See ndbcStations.ts
// for why this exists (the 2026-09-18 Boca "3.1 ft model vs 1 ft real" bug).

describe("buoy wave coverage (deterministic — the CI guard)", () => {
  it("every configured beach has at least one wave-reporting NDBC station", () => {
    const violations = buoyCoverageViolations(LOCATIONS);
    // A readable failure: list each offending beach and how to fix it.
    expect(
      violations,
      violations.map((v) => `\n  • ${v.slug} [${v.reason}]: ${v.detail}`).join(""),
    ).toEqual([]);
  });

  it("every NDBC station in the config is classified (no unknowns)", () => {
    const configured = new Set<string>();
    for (const loc of LOCATIONS) {
      configured.add(loc.ndbcBuoyId);
      if (loc.ndbcBuoyFallbackId) configured.add(loc.ndbcBuoyFallbackId);
    }
    const unknown = [...configured].filter((id) => reportsWaves(id) === undefined);
    expect(
      unknown,
      `Classify these NDBC stations in NDBC_STATION_REPORTS_WAVES: ${unknown.join(", ")}`,
    ).toEqual([]);
  });

  it("catches the Boca-style bug: a pair of wave-less stations", () => {
    const bad: BuoyConfigured[] = [
      { slug: "test-beach", ndbcBuoyId: "LKWF1", ndbcBuoyFallbackId: "FWYF1" },
    ];
    const violations = buoyCoverageViolations(bad);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ slug: "test-beach", reason: "no-wave-station" });
  });

  it("flags an unclassified station so new configs can't slip through", () => {
    const bad: BuoyConfigured[] = [
      { slug: "test-beach", ndbcBuoyId: "99999", ndbcBuoyFallbackId: "41122" },
    ];
    const violations = buoyCoverageViolations(bad);
    expect(violations).toHaveLength(1);
    expect(violations[0].reason).toBe("unclassified-station");
  });

  it("accepts a beach that has a real wave buoy anywhere in its pair", () => {
    const ok: BuoyConfigured[] = [
      { slug: "a", ndbcBuoyId: "41122" }, // wave buoy as primary, no fallback
      { slug: "b", ndbcBuoyId: "LKWF1", ndbcBuoyFallbackId: "41122" }, // as fallback
    ];
    expect(buoyCoverageViolations(ok)).toEqual([]);
  });
});

// Live audit — OFF by default (network + station uptime make it non-deterministic,
// so it must never gate a merge). Run on demand to confirm the static map above
// still matches reality — the ground-truth backstop:
//   NDBC_LIVE_CHECK=1 npx vitest run lib/sources/ndbcStations.test.ts
const LIVE = process.env.NDBC_LIVE_CHECK === "1";

/** WVHT is column index 8 of an NDBC realtime2 row; "MM" means missing. Returns
 *  true if any of the most recent rows carries a numeric wave height. */
function feedReportsWaves(text: string): boolean {
  const rows = text
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .slice(0, 24); // ~last few hours; tolerate transient gaps
  return rows.some((row) => {
    const wvht = row.trim().split(/\s+/)[8];
    return wvht !== undefined && wvht !== "MM" && Number.isFinite(Number(wvht));
  });
}

(LIVE ? describe : describe.skip)("buoy wave coverage (live NDBC audit)", () => {
  for (const [station, expected] of Object.entries(NDBC_STATION_REPORTS_WAVES)) {
    it(`${station} really ${expected ? "reports" : "does not report"} waves`, async () => {
      const res = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${station}.txt`);
      // A dead/decommissioned station 404s. If we CLAIM it reports waves, that is
      // itself a coverage problem worth surfacing; a wave-less station going dark
      // is harmless to this map, so only assert the feed for stations we rely on.
      if (!res.ok) {
        expect(expected, `${station} feed returned ${res.status}`).toBe(false);
        return;
      }
      expect(feedReportsWaves(await res.text())).toBe(expected);
    }, 20_000);
  }
});
