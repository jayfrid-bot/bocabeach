import { afterEach, describe, it, expect, vi } from "vitest";
import { fetchBuoy, parseNdbcRealtime, parseNdbcWaterHistory } from "@/lib/sources/buoy";
import type { Location } from "@/lib/types";

const SAMPLE = `#YY  MM DD hh mm WDIR WSPD GST  WVHT   DPD   APD MWD   PRES  ATMP  WTMP  DEWP  VIS PTDY  TIDE
#yr  mo dy hr mn degT m/s  m/s     m   sec   sec degT   hPa  degC  degC  degC  nmi  hPa   ft
2026 05 29 14 30 120  5.0  7.0    MM    MM    MM  MM 1015.0  27.0  28.0  22.0   MM   MM    MM
2026 05 29 14 00 130  4.5  6.0    MM    MM    MM  MM 1015.2  26.8  28.0  22.0   MM   MM    MM`;

describe("parseNdbcRealtime", () => {
  it("parses the most recent row and converts units", () => {
    const d = parseNdbcRealtime(SAMPLE);
    expect(d).not.toBeNull();
    expect(d!.windDirDeg).toBe(120);
    expect(d!.windSpeedMph).toBe(11); // 5.0 m/s
    expect(d!.windGustMph).toBe(16); // 7.0 m/s
    expect(d!.airTempF).toBe(81); // 27.0 C
    expect(d!.waterTempF).toBe(82); // 28.0 C
    expect(d!.observedAt).toBe("2026-05-29T14:30:00.000Z");
  });

  it("treats MM as missing", () => {
    const d = parseNdbcRealtime(SAMPLE);
    expect(d!.waveHeightFt).toBeUndefined();
    expect(d!.dominantPeriodS).toBeUndefined();
  });

  it("returns null when there are no data rows", () => {
    expect(parseNdbcRealtime("#header only\n#units")).toBeNull();
  });
});

describe("parseNdbcWaterHistory — timestamp validation", () => {
  const HEADER = "#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP\n";
  // now = 2026-06-01T12:00Z; the 7.5-day cutoff reaches back to 2026-05-25.
  const NOW = Date.parse("2026-06-01T12:00:00Z");

  it("rejects rows with out-of-range date components (Date.UTC would silently normalize them into the window)", () => {
    const text =
      HEADER +
      // valid: 2026-05-29T23:30Z, WTMP 28.0C -> 82F
      "2026 05 29 23 30 120 5.0 7.0 MM MM MM MM 1015.0 27.0 28.0\n" +
      // hour 25 -> Date.UTC normalizes to 2026-05-30T01:30Z (in window) — must be dropped
      "2026 05 29 25 30 120 5.0 7.0 MM MM MM MM 1015.0 27.0 27.0\n" +
      // day 32 -> Date.UTC normalizes to 2026-06-01T10:30Z (in window) — must be dropped
      "2026 05 32 10 30 120 5.0 7.0 MM MM MM MM 1015.0 27.0 26.0\n";
    const hist = parseNdbcWaterHistory(text, NOW);
    expect(hist).toBeDefined();
    expect(hist!.length).toBe(1); // only the genuinely-valid row survives
    expect(hist![0].t).toBe("2026-05-29T23:30:00.000Z");
    expect(hist![0].waterTempF).toBe(82);
  });
});

// --- fetchBuoy station selection --------------------------------------------

/** Format an instant as NDBC realtime2 leading columns "YYYY MM DD hh mm". */
function ndbcStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()} ${p(d.getUTCMonth() + 1)} ${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )} ${p(d.getUTCMinutes())}`;
}

describe("fetchBuoy — station eligibility ignores water-temp history", () => {
  afterEach(() => vi.unstubAllGlobals());

  const loc = {
    ndbcBuoyId: "PRIMARY",
    ndbcBuoyFallbackId: "FALLBACK",
  } as unknown as Location;

  it("a primary whose current row is empty-but-for-a-timestamp (yet has old WTMP history) is treated unusable and falls back to a live station", async () => {
    const now = Date.now();
    const at0 = new Date(now - 20 * 60_000); // 20 min ago
    const at1 = new Date(now - 80 * 60_000);
    const at2 = new Date(now - 140 * 60_000);
    const header = "#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP\n";

    // PRIMARY: latest row has ALL metrics missing (only a valid timestamp), but
    // older rows carry valid WTMP -> waterTempHistory attaches. Before the fix,
    // that history inflated the key count and wrongly passed the usability gate.
    const primaryText =
      header +
      `${ndbcStamp(at0)} MM MM MM MM MM MM MM MM MM MM\n` +
      `${ndbcStamp(at1)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 26.0\n` +
      `${ndbcStamp(at2)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 26.0\n`;

    // FALLBACK: a live current row with real wind/waves/water (WTMP 27.0C -> 81F).
    const fallbackText =
      header + `${ndbcStamp(at0)} 100 4.0 6.0 1.0 8 5 90 1016.0 28.0 27.0\n`;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("PRIMARY") ? primaryText : fallbackText;
        return new Response(body, { status: 200, headers: { date: new Date().toUTCString() } });
      }),
    );

    const res = await fetchBuoy(loc);
    // Station selection must be driven by the CURRENT row's usable metrics, not
    // by the presence of trailing history — so the dead primary is skipped and
    // the live fallback (which feeds waterTempF into scoring) is used.
    expect(res.source).toContain("FALLBACK");
    expect(res.status).toBe("stale"); // a fallback is always marked stale
    expect(res.note).toMatch(/primary buoy unavailable/i);
    expect(res.data?.waterTempF).toBe(81); // the live fallback's reading, not undefined
  });
});
