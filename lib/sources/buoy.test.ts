import { afterEach, describe, it, expect, vi } from "vitest";
import {
  fetchBuoy,
  mergeBuoyStations,
  parseNdbcRealtime,
  parseNdbcWaterHistory,
} from "@/lib/sources/buoy";
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

// ---------------------------------------------------------------------------
// PER-FIELD MERGE across the station pair.
// The real problem this solves (45-day audit of Boca's pair, 2026-07): LKWF1 is
// a C-MAN mast with NO wave sensor (WVHT/DPD "MM" on 100% of ticks) that also
// drops WTMP on ~21-24% of ticks. The old all-or-nothing gate let a wind-only
// LKWF1 row win the whole station and silently discarded FWYF1's water temp —
// the value that feeds the 9%-weighted waterTemp sub-score.
// ---------------------------------------------------------------------------
describe("fetchBuoy — per-field merge across primary + fallback", () => {
  afterEach(() => vi.unstubAllGlobals());

  const loc = {
    ndbcBuoyId: "LKWF1",
    ndbcBuoyFallbackId: "FWYF1",
  } as unknown as Location;
  const header = "#YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP\n";

  /** Stub both station fetches with the given realtime2 bodies. */
  function stub(primaryText: string, fallbackText: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("LKWF1") ? primaryText : fallbackText;
        return new Response(body, { status: 200, headers: { date: new Date().toUTCString() } });
      }),
    );
  }

  it("a wind-only primary no longer costs us the fallback's water temp", async () => {
    const at = new Date(Date.now() - 20 * 60_000);
    // LKWF1 as it really behaves: wind + air temp, WVHT/DPD/WTMP all missing.
    const primaryText = header + `${ndbcStamp(at)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 MM\n`;
    // FWYF1 carries the water temp (28.0 C -> 82 F) plus its own wind.
    const fallbackText = header + `${ndbcStamp(at)} 100 4.0 6.0 MM MM MM MM 1016.0 28.5 28.0\n`;
    stub(primaryText, fallbackText);

    const res = await fetchBuoy(loc);
    // Nearest station wins the fields it actually reported...
    expect(res.data?.windDirDeg).toBe(120);
    expect(res.data?.windSpeedMph).toBe(11); // 5.0 m/s, LKWF1's
    expect(res.data?.airTempF).toBe(81); // 27.0 C, LKWF1's
    // ...and the fallback fills only the gap. This value was being thrown away.
    expect(res.data?.waterTempF).toBe(82);
    // Provenance is explicit, field by field.
    expect(res.data?.sources?.windSpeedMph).toBe("LKWF1");
    expect(res.data?.sources?.airTempF).toBe("LKWF1");
    expect(res.data?.sources?.waterTempF).toBe("FWYF1");
    expect(res.source).toContain("LKWF1");
    expect(res.source).toContain("FWYF1");
  });

  it("waves stay NULL when neither C-MAN mast has a wave sensor — never invented", async () => {
    const at = new Date(Date.now() - 20 * 60_000);
    const row = `${ndbcStamp(at)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 28.0\n`;
    stub(header + row, header + row);

    const res = await fetchBuoy(loc);
    expect(res.data?.waveHeightFt).toBeUndefined();
    expect(res.data?.dominantPeriodS).toBeUndefined();
    // "Neither station reported this" is recorded as an explicit null, which is
    // what lets the nerd card say the wave number is a model, not a buoy.
    expect(res.data?.sources?.waveHeightFt).toBeNull();
    expect(res.data?.sources?.dominantPeriodS).toBeNull();
  });

  it("a healthy primary that merely lacks a sensor is NOT marked stale — it's the normal case", async () => {
    const at = new Date(Date.now() - 20 * 60_000);
    stub(
      header + `${ndbcStamp(at)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 MM\n`,
      header + `${ndbcStamp(at)} 100 4.0 6.0 MM MM MM MM 1016.0 28.5 28.0\n`,
    );
    const res = await fetchBuoy(loc);
    expect(res.status).toBe("ok");
    expect(res.note).toMatch(/waterTempF from FWYF1/);
  });

  it("prefers the PRIMARY's water-temp history so the trend line is one consistent series", async () => {
    const at0 = new Date(Date.now() - 20 * 60_000);
    const at1 = new Date(Date.now() - 80 * 60_000);
    // LKWF1: current row has no WTMP, but earlier rows do -> it has a history.
    const primaryText =
      header +
      `${ndbcStamp(at0)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 MM\n` +
      `${ndbcStamp(at1)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 25.0\n`; // 77 F
    const fallbackText = header + `${ndbcStamp(at0)} 100 4.0 6.0 MM MM MM MM 1016.0 28.5 28.0\n`; // 82 F
    stub(primaryText, fallbackText);

    const res = await fetchBuoy(loc);
    // The displayed water temp comes from FWYF1 (the primary had none)...
    expect(res.data?.waterTempF).toBe(82);
    expect(res.data?.sources?.waterTempF).toBe("FWYF1");
    // ...while the TREND series stays LKWF1's: splicing two stations'
    // temperatures into one line would manufacture jumps that aren't real.
    expect(res.data?.waterTempHistory?.[0].waterTempF).toBe(77);
  });

  it("falls back to the fallback's history when the primary published none", async () => {
    const at = new Date(Date.now() - 20 * 60_000);
    stub(
      header + `${ndbcStamp(at)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 MM\n`,
      header + `${ndbcStamp(at)} 100 4.0 6.0 MM MM MM MM 1016.0 28.5 28.0\n`,
    );
    const res = await fetchBuoy(loc);
    expect(res.data?.waterTempHistory?.[0].waterTempF).toBe(82);
  });

  it("survives a fallback that 404s — the primary's fields still merge through", async () => {
    const at = new Date(Date.now() - 20 * 60_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("FWYF1")) return new Response("nope", { status: 404 });
        return new Response(
          header + `${ndbcStamp(at)} 120 5.0 7.0 MM MM MM MM 1015.0 27.0 28.0\n`,
          { status: 200, headers: { date: new Date().toUTCString() } },
        );
      }),
    );
    const res = await fetchBuoy(loc);
    expect(res.status).toBe("ok");
    expect(res.data?.waterTempF).toBe(82);
    expect(res.data?.sources?.waterTempF).toBe("LKWF1");
    expect(res.source).toBe("NOAA NDBC (LKWF1)");
  });

  it("errors honestly when BOTH stations are unusable", async () => {
    stub(header, header);
    const res = await fetchBuoy(loc);
    expect(res.status).toBe("error");
    expect(res.data).toBeNull();
  });
});

describe("mergeBuoyStations (pure)", () => {
  const P = { id: "LKWF1", at: "2026-07-28T19:00:00.000Z", data: {} };
  const F = { id: "FWYF1", at: "2026-07-28T19:00:00.000Z", data: {} };

  it("primary wins every field it reported; fallback covers only the gaps", () => {
    const out = mergeBuoyStations(
      { ...P, data: { windSpeedMph: 11, waterTempF: 80, observedAt: "2026-07-28T19:00:00.000Z" } },
      { ...F, data: { windSpeedMph: 9, waterTempF: 82, waveHeightFt: 2.1 } },
    )!;
    expect(out.data.windSpeedMph).toBe(11);
    expect(out.data.waterTempF).toBe(80); // NOT the fallback's 82
    expect(out.data.waveHeightFt).toBe(2.1); // only field the primary lacked
    expect(out.filledByFallback).toEqual(["waveHeightFt"]);
    expect(out.contributors).toEqual(["LKWF1", "FWYF1"]);
  });

  it("records an explicit null for a field neither station reported", () => {
    const out = mergeBuoyStations({ ...P, data: { windSpeedMph: 11 } }, null)!;
    expect(out.data.sources?.windSpeedMph).toBe("LKWF1");
    expect(out.data.sources?.waterTempF).toBeNull();
    expect(out.contributors).toEqual(["LKWF1"]);
  });

  it("returns null when there is nothing to merge", () => {
    expect(mergeBuoyStations(null, null)).toBeNull();
    expect(mergeBuoyStations({ ...P, data: {} }, { ...F, data: {} })).toBeNull();
  });
});
