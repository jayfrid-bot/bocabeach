import { describe, it, expect } from "vitest";
import { parseByPoint, nearestPoint, candidateCycles, parseCoverageTs, isRunUsable, pointCoversWindow, resolveBeachEntry, POINT_TOLERANCE_DEG } from "@/scripts/rip_nwps.mjs";
import fs from "node:fs";
import path from "node:path";

// Real sample rows from a NOAA NWPS CG1 ripprob file (MFL office, 2026-09-24
// 00z run), grouped by point per the file's actual layout: each point's
// hourly rows appear consecutively, not grouped by timestamp.
const SAMPLE_TEXT = `%
%
% Run:2400  Table:5mcont            SWAN version:41.10
% Rip Current Code Version:1.0
%
%DATE             Xp           Yp         Prob     Hs         pp        mwdsn      tide  event
 20260924.0000    279.9170     26.9918      4.9    0.4449      7.558     -11.939     0.49  0
 20260924.0100    279.9170     26.9918      6.6    0.4485      7.564     -12.181     0.33  0
 20260924.0000    279.9340     26.3616      7.0    0.4576      3.000      -2.190     0.49  0
 20260924.0100    279.9340     26.3616      7.7    0.4582      3.075      -7.187     0.35  0
 20260924.0200    279.9340     26.3616      9.1    0.4617      3.156     -11.595     0.18  0
`;

describe("parseByPoint (scripts/rip_nwps.mjs)", () => {
  it("groups rows by grid point (the file's actual layout), converting lon+360 -> lon and m -> ft", () => {
    const byPoint = parseByPoint(SAMPLE_TEXT);
    expect(byPoint.size).toBe(2);
    const boca = byPoint.get("279.9340,26.3616");
    expect(boca?.lon).toBeCloseTo(-80.066, 3);
    expect(boca?.lat).toBeCloseTo(26.3616, 4);
    expect(boca?.rows).toHaveLength(3);
    expect(boca?.rows[0].prob).toBe(7.0);
    expect(boca?.rows[0].hsFt).toBeCloseTo(0.4576 * 3.28084, 3);
    expect(boca?.rows[0].t).toBe("2026-09-24T00:00:00.000Z");
  });

  it("skips header/comment lines and malformed rows", () => {
    const byPoint = parseByPoint("% just a comment\nnot a data row\n");
    expect(byPoint.size).toBe(0);
  });
});

describe("nearestPoint (scripts/rip_nwps.mjs)", () => {
  it("picks the closest grid point to a beach's lat/lon", () => {
    const byPoint = parseByPoint(SAMPLE_TEXT);
    // Boca Raton's real pin: 26.3587, -80.0686 — much closer to the
    // 279.9340/26.3616 point than the 279.9170/26.9918 point ~70km north.
    const nearest = nearestPoint(byPoint, 26.3587, -80.0686);
    expect(nearest?.lat).toBeCloseTo(26.3616, 3);
  });
});

describe("candidateCycles (scripts/rip_nwps.mjs)", () => {
  it("tries today 12z, today 00z, yesterday 12z, yesterday 00z in order", () => {
    const now = new Date("2026-09-24T18:30:00Z");
    const cycles = candidateCycles(now);
    expect(cycles).toEqual([
      { date: "20260924", hour: "12" },
      { date: "20260924", hour: "00" },
      { date: "20260923", hour: "12" },
      { date: "20260923", hour: "00" },
    ]);
  });
});

describe("parseCoverageTs (scripts/rip_nwps.mjs)", () => {
  it("parses the real committed config/nwpsRip.ts and finds boca-raton", () => {
    const tsPath = path.resolve(process.cwd(), "config/nwpsRip.ts");
    expect(fs.existsSync(tsPath)).toBe(true);
    const coverage = parseCoverageTs(tsPath) as Record<
      string,
      { region: string; office: string; lon: number; lat: number; distKm: number }
    >;
    expect(coverage["boca-raton"]).toBeDefined();
    expect(coverage["boca-raton"].office).toBe("mfl");
    expect(coverage["boca-raton"].distKm).toBeLessThanOrEqual(3);
  });
});

describe("parseByPoint — rejects out-of-range/sentinel probability rows (item 7)", () => {
  it("drops a row whose prob is negative, >100, or non-numeric, but keeps the point's other valid rows", () => {
    const text = `%DATE             Xp           Yp         Prob     Hs         pp        mwdsn      tide  event
 20260924.0000    279.9340     26.3616      -999    0.4576      3.000      -2.190     0.49  0
 20260924.0100    279.9340     26.3616      7.7    0.4582      3.075      -7.187     0.35  0
 20260924.0200    279.9340     26.3616      150.0    0.4617      3.156     -11.595     0.18  0
 20260924.0300    279.9340     26.3616      NaN    0.4617      3.156     -11.595     0.18  0
`;
    const byPoint = parseByPoint(text);
    const boca = byPoint.get("279.9340,26.3616");
    expect(boca?.rows).toHaveLength(1);
    expect(boca?.rows[0].prob).toBe(7.7);
  });

  it("drops a row with an out-of-range lat/lon", () => {
    const text = `%DATE             Xp           Yp         Prob     Hs         pp        mwdsn      tide  event
 20260924.0000    279.9340     999.0000      7.0    0.4576      3.000      -2.190     0.49  0
`;
    expect(parseByPoint(text).size).toBe(0);
  });

  it("drops a row with a malformed timestamp (bad hour/minute)", () => {
    const text = `%DATE             Xp           Yp         Prob     Hs         pp        mwdsn      tide  event
 20260924.9999    279.9340     26.3616      7.0    0.4576      3.000      -2.190     0.49  0
`;
    expect(parseByPoint(text).size).toBe(0);
  });
});

describe("isRunUsable — coverage + non-empty-grid sanity gate (item 10)", () => {
  const nowMs = Date.parse("2026-09-24T12:00:00Z");

  it("rejects an empty grid", () => {
    expect(isRunUsable(new Map(), nowMs)).toBe(false);
  });

  it("rejects a grid whose only point is missing hours within the next 24h", () => {
    const byPoint = new Map([
      [
        "k",
        {
          lon: -80,
          lat: 26,
          rows: [{ t: "2026-09-24T12:00:00.000Z", prob: 5 }], // only 1 of the 25 needed hours
        },
      ],
    ]);
    expect(isRunUsable(byPoint, nowMs)).toBe(false);
  });

  it("accepts a grid with at least one point covering now..+24h with no gaps", () => {
    const rows = [];
    for (let h = 0; h <= 24; h++) {
      rows.push({ t: new Date(nowMs + h * 3_600_000).toISOString(), prob: 5 });
    }
    const byPoint = new Map([["k", { lon: -80, lat: 26, rows }]]);
    expect(isRunUsable(byPoint, nowMs)).toBe(true);
  });
});

describe("parseByPoint — UTC timestamp parsing across a US DST transition (2026-03-08 2am EST->EDT)", () => {
  it("parses a 'spring forward' date's hours as plain UTC — no local-time DST skip/duplicate", () => {
    // 2026-03-08 is the US DST transition (2 AM EST -> 3 AM EDT). The file's
    // timestamps are UTC (see isoParts's comment), so this must produce a
    // perfectly regular hourly UTC sequence with no gap/repeat at 07:00Z
    // (= 2/3 AM local) the way a naive local-time parse could introduce.
    const rows = ["0000", "0100", "0600", "0700", "0800"].map(
      (hm) => ` 20260308.${hm}    279.9340     26.3616      5.0    0.40      7.0      -10.0     0.30  0`,
    );
    const text = "%DATE\n" + rows.join("\n");
    const byPoint = parseByPoint(text);
    const entry = byPoint.get("279.9340,26.3616");
    const times = entry.rows.map((r: { t: string }) => r.t);
    expect(times).toEqual([
      "2026-03-08T00:00:00.000Z",
      "2026-03-08T01:00:00.000Z",
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T08:00:00.000Z",
    ]);
    // Plain UTC arithmetic throughout — the 01:00Z -> 06:00Z gap in the fixture
    // is exactly 5h, and the 06:00Z -> 07:00Z / 07:00Z -> 08:00Z hours (which
    // straddle 2 AM local EST/EDT) are each exactly 1h, with no DST skip/repeat.
    expect(Date.parse(times[2]) - Date.parse(times[1])).toBe(5 * 3_600_000);
    expect(Date.parse(times[3]) - Date.parse(times[2])).toBe(3_600_000);
    expect(Date.parse(times[4]) - Date.parse(times[3])).toBe(3_600_000);
  });
});

describe("resolveBeachEntry — per-beach configured-point tolerance + coverage (item 2)", () => {
  const nowMs = Date.parse("2026-09-24T12:00:00Z");
  const RUN = "2026-09-24T00:00:00Z";
  const OFFICE = "mfl";

  function fullCoverageRows(lon: number, lat: number, startMs: number) {
    const rows = [];
    for (let h = -1; h <= 30; h++) {
      rows.push({
        t: new Date(startMs + h * 3_600_000).toISOString(),
        prob: 5,
        lon,
        lat,
      });
    }
    return rows;
  }

  // Two-point file: the beach's CONFIGURED point (boca, exact match) and a
  // second, unrelated point (some other beach up the coast) — a realistic
  // small/truncated CG1 file, not the full ~186-point grid.
  function twoPointByPoint({ bocaLon = -80.066, bocaLat = 26.3616, bocaCoverage = true } = {}) {
    const m = new Map();
    m.set("boca", {
      lon: bocaLon,
      lat: bocaLat,
      rows: bocaCoverage
        ? fullCoverageRows(bocaLon, bocaLat, nowMs)
        : [{ t: new Date(nowMs).toISOString(), prob: 5, lon: bocaLon, lat: bocaLat }], // only 1 hour — no coverage
    });
    m.set("other", {
      lon: -80.6,
      lat: 28.3,
      rows: fullCoverageRows(-80.6, 28.3, nowMs),
    });
    return m;
  }

  const BOCA_BEACH = { slug: "boca-raton", lat: 26.3616, lon: -80.066 };

  it("uses the configured point when it exactly matches and has full coverage", () => {
    const byPoint = twoPointByPoint();
    const entry = resolveBeachEntry(BOCA_BEACH, byPoint, null, nowMs, OFFICE, RUN);
    expect(entry).not.toBeNull();
    expect(entry.point.lat).toBeCloseTo(26.3616, 4);
    expect(entry.office).toBe(OFFICE);
    expect(entry.run).toBe(RUN);
  });

  it("carries forward the beach's PRIOR entry (with its ORIGINAL run) when the configured point is missing from a truncated file", () => {
    // Truncated file: neither point is anywhere near Boca's configured
    // coordinate (simulates the exact point having dropped out of the grid).
    const byPoint = new Map();
    byPoint.set("far1", { lon: -80.6, lat: 28.3, rows: fullCoverageRows(-80.6, 28.3, nowMs) });
    byPoint.set("far2", { lon: -81.0, lat: 30.0, rows: fullCoverageRows(-81.0, 30.0, nowMs) });
    const prevEntry = {
      office: OFFICE,
      run: "2026-09-23T12:00:00Z", // an OLDER run, from the previous good publish
      point: { lon: -80.066, lat: 26.3616 },
      hours: [{ t: "2026-09-23T12:00:00.000Z", prob: 4 }],
    };
    const entry = resolveBeachEntry(BOCA_BEACH, byPoint, prevEntry, nowMs, OFFICE, RUN);
    expect(entry).toEqual(prevEntry);
    expect(entry.run).toBe("2026-09-23T12:00:00Z"); // never stamped as fresh
  });

  it("carries forward when the nearest point is outside POINT_TOLERANCE_DEG even though it's the 'closest available'", () => {
    // The nearest point is 0.5 deg away (~55km) — plausible in a sparse
    // truncated file, but nowhere near tight enough to trust as "the"
    // configured point.
    const byPoint = new Map();
    byPoint.set("nearish", {
      lon: BOCA_BEACH.lon + 0.5,
      lat: BOCA_BEACH.lat,
      rows: fullCoverageRows(BOCA_BEACH.lon + 0.5, BOCA_BEACH.lat, nowMs),
    });
    const prevEntry = { office: OFFICE, run: "2026-09-23T12:00:00Z", point: { lon: -80.066, lat: 26.3616 }, hours: [] };
    const entry = resolveBeachEntry(BOCA_BEACH, byPoint, prevEntry, nowMs, OFFICE, RUN);
    expect(entry).toBe(prevEntry);
  });

  it("carries forward when the configured point matches but lacks continuous now..+24h coverage (short-horizon truncation)", () => {
    const byPoint = twoPointByPoint({ bocaCoverage: false });
    const prevEntry = { office: OFFICE, run: "2026-09-23T12:00:00Z", point: { lon: -80.066, lat: 26.3616 }, hours: [] };
    const entry = resolveBeachEntry(BOCA_BEACH, byPoint, prevEntry, nowMs, OFFICE, RUN);
    expect(entry).toBe(prevEntry);
  });

  it("returns null (not a fabricated entry) when the point is unusable AND there's no previous data", () => {
    const byPoint = twoPointByPoint({ bocaCoverage: false });
    const entry = resolveBeachEntry(BOCA_BEACH, byPoint, null, nowMs, OFFICE, RUN);
    expect(entry).toBeNull();
  });
});

describe("pointCoversWindow / POINT_TOLERANCE_DEG", () => {
  it("POINT_TOLERANCE_DEG is tight (~1km class), not the 3km beach-mapping tolerance", () => {
    expect(POINT_TOLERANCE_DEG).toBeLessThanOrEqual(0.01);
  });

  it("rejects a point with a gap in its now..+24h coverage", () => {
    const nowMs = Date.parse("2026-09-24T12:00:00Z");
    const rows = [];
    for (let h = 0; h <= 24; h++) {
      if (h === 12) continue; // one missing hour = a gap
      rows.push({ t: new Date(nowMs + h * 3_600_000).toISOString(), prob: 5 });
    }
    expect(pointCoversWindow({ rows }, nowMs)).toBe(false);
  });
});
