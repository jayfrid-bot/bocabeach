import { describe, it, expect } from "vitest";
import { getLocation, listLocations } from "@/config/locations";
import { scorableResponse } from "@/lib/alerts/fixtures";
import { estimateSurfHeightFt } from "@/lib/surfHeight";
import {
  coverageTier,
  hourUtcOf,
  isDaylightAt,
  localHourParts,
  orderArchiveCandidates,
  rowFromConditions,
  shouldArchiveNow,
  sunBuildsDueToday,
  sunWindowEventMs,
  sunWindowPriority,
} from "@/lib/history/archive";

describe("hourUtcOf", () => {
  it("floors to the top of the UTC hour", () => {
    expect(hourUtcOf(Date.parse("2026-09-20T14:37:12.345Z"))).toBe("2026-09-20T14:00:00.000Z");
    expect(hourUtcOf(Date.parse("2026-09-20T14:00:00.000Z"))).toBe("2026-09-20T14:00:00.000Z");
  });
});

describe("localHourParts — DST safety", () => {
  // America/New_York falls back from 2:00 AM EDT to 1:00 AM EST at
  // 2026-11-01T06:00:00Z. The hour immediately before that instant and the
  // hour immediately after both read as local 1 AM on 2026-11-01 — but they
  // are different UTC hours with different offsets, so they must never
  // collide on the (slug, hour_utc) primary key.
  it("gives the two 1 AM fall-back occurrences distinct UTC hours and offsets", () => {
    const beforeFallback = localHourParts("America/New_York", Date.parse("2026-11-01T05:30:00Z")); // 1:30 EDT
    const afterFallback = localHourParts("America/New_York", Date.parse("2026-11-01T06:30:00Z")); // 1:30 EST

    expect(beforeFallback.date).toBe("2026-11-01");
    expect(afterFallback.date).toBe("2026-11-01");
    expect(beforeFallback.hour).toBe(1);
    expect(afterFallback.hour).toBe(1);

    // Distinct offsets (EDT -240 vs EST -300)...
    expect(beforeFallback.offsetMinutes).toBe(-240);
    expect(afterFallback.offsetMinutes).toBe(-300);

    // ...and therefore distinct hour_utc keys once floored.
    expect(hourUtcOf(Date.parse("2026-11-01T05:30:00Z"))).not.toBe(
      hourUtcOf(Date.parse("2026-11-01T06:30:00Z")),
    );
  });

  it("resolves a summer instant to EDT (-240)", () => {
    const p = localHourParts("America/New_York", Date.parse("2026-07-04T16:00:00Z"));
    expect(p.offsetMinutes).toBe(-240);
    expect(p.hour).toBe(12);
  });
});

describe("coverageTier", () => {
  const boca = getLocation("boca-raton")!;

  it("is 'full' for a beach with cams and a water-quality config", () => {
    const res = scorableResponse();
    expect(coverageTier(boca, res)).toBe("full");
  });

  it("is 'standard' for a beach with observed waves + water temp but no cams/water-quality config", () => {
    const noCamsLoc = { ...boca, cams: [], healthyBeaches: undefined };
    const res = scorableResponse();
    res.snapshot.buoy = { source: "test", status: "ok", fetchedAt: "", attribution: "test", data: { waveHeightFt: 2.1 } };
    // scorableResponse's marine wraps a water proxy (seaSurfaceTempF), which
    // deriveMetrics falls back to for waterTempF when no buoy WTMP exists.
    expect(coverageTier(noCamsLoc, res)).toBe("standard");
  });

  it("is 'limited' otherwise", () => {
    const bareLoc = { ...boca, cams: [], healthyBeaches: undefined };
    const res = scorableResponse();
    res.snapshot.marine = { source: "test", status: "error", fetchedAt: "", attribution: "test", data: null };
    res.snapshot.buoy = { source: "test", status: "error", fetchedAt: "", attribution: "test", data: null };
    expect(coverageTier(bareLoc, res)).toBe("limited");
  });
});

describe("rowFromConditions", () => {
  const boca = getLocation("boca-raton")!;

  it("keys the row by the UTC hour of snapshot.generatedAt, not Date.now()", () => {
    const res = scorableResponse();
    const nowMs = Date.now(); // deliberately far from the fixture's generatedAt
    const row = rowFromConditions(res, boca, nowMs);
    expect(row.hour_utc).toBe(hourUtcOf(Date.parse(res.snapshot.generatedAt)));
    expect(row.snapshot_generated_at).toBe(res.snapshot.generatedAt);
    expect(row.archived_at).toBe(new Date(nowMs).toISOString());
  });

  it("carries score, rating, engine + config version, and row_kind='snapshot'", () => {
    const res = scorableResponse();
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.score).toBe(res.score.score);
    expect(row.raw_score).toBe(res.score.rawScore);
    expect(row.rating).toBe(res.score.rating);
    expect(row.row_kind).toBe("snapshot");
    expect(row.engine_version).toBeTruthy();
    expect(row.scoring_config_version).toBeTruthy();
    expect(row.slug).toBe("boca-raton");
  });

  it("computes local_date/local_hour/utc_offset_minutes for the beach's own timezone", () => {
    const res = scorableResponse();
    const expected = localHourParts(boca.timezone, Date.parse(res.snapshot.generatedAt));
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.local_date).toBe(expected.date);
    expect(row.local_hour).toBe(expected.hour);
    expect(row.utc_offset_minutes).toBe(expected.offsetMinutes);
    expect(row.timezone).toBe(boca.timezone);
  });

  // Codex review 2026-09-28 #1: wave_ft has always meant the RAW significant
  // wave height (Hs) — the surf-height feature must not silently redefine it
  // to mean the estimated surf (breaking) height, or a trend chart mixing
  // old and new rows under the same column name would read a long-period
  // swell day as if the sea calmed down. The estimate belongs in the new
  // surf_ft column (migration 0010) instead.
  it("wave_ft stays the raw Hs while surf_ft carries the estimated surf height", () => {
    const res = scorableResponse();
    res.snapshot.marine = {
      source: "test",
      status: "ok",
      fetchedAt: "",
      attribution: "test",
      data: { waveHeightFt: 2.6, wavePeriodS: 15 }, // long-period swell — amplifies
    };
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.wave_ft).toBe(2.6); // raw Hs, unamplified
    expect(row.surf_ft).toBe(estimateSurfHeightFt(2.6, 15));
    expect(row.surf_ft).toBeGreaterThan(row.wave_ft!);
  });

  it("surf_ft is null when there's no wave reading at all", () => {
    const res = scorableResponse();
    res.snapshot.marine = { source: "test", status: "error", fetchedAt: "", attribution: "test", data: null };
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.wave_ft).toBeNull();
    expect(row.surf_ft).toBeNull();
  });

  // Codex review round-2 #1: wave_ft must read the TRUE raw total Hs even
  // when the surf estimate itself falls back to the swell component (total
  // period missing, swell-based surf beats the raw total) — reading
  // `d.waveSwellHeightFt` here (which can legitimately BECOME the swell
  // height in that case) would have silently swapped in 1.2 instead of 1.5.
  it("wave_ft stays the raw TOTAL Hs even when the surf estimate falls back to the swell component", () => {
    const res = scorableResponse();
    res.snapshot.marine = {
      source: "test",
      status: "ok",
      fetchedAt: "",
      attribution: "test",
      data: { waveHeightFt: 1.5, swellHeightFt: 1.2, swellPeriodS: 15 }, // no total period
    };
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.wave_ft).toBe(1.5); // raw TOTAL Hs, not the 1.2 ft swell component
    expect(row.surf_ft).toBeCloseTo(2.7, 1);
  });

  // Codex review round-3 #2: a surf estimate computed from a swell-only
  // MODEL pair (no total height reported at all) must still archive
  // wave_source as "model", not null — the old bug only checked the
  // model's TOTAL field for provenance, missing the swell-only fallback.
  it("wave_source archives as 'model' when the surf estimate came from a swell-only model pair", () => {
    const res = scorableResponse();
    res.snapshot.marine = {
      source: "test",
      status: "ok",
      fetchedAt: "",
      attribution: "test",
      data: { swellHeightFt: 1.2, swellPeriodS: 15 }, // no total height at all
    };
    const row = rowFromConditions(res, boca, Date.now());
    expect(row.wave_ft).toBeNull(); // no total Hs to report
    expect(row.surf_ft).toBeCloseTo(2.7, 1);
    expect(row.wave_source).toBe("model");
  });

  it("serializes caps/factors/missing as JSON arrays", () => {
    const res = scorableResponse();
    const row = rowFromConditions(res, boca, Date.now());
    expect(() => JSON.parse(row.caps_json!)).not.toThrow();
    expect(Array.isArray(JSON.parse(row.factors_json!))).toBe(true);
    expect(Array.isArray(JSON.parse(row.missing_json!))).toBe(true);
  });

  // Codex round-2 finding #1: the route claims a specific hour_utc BEFORE
  // fetching, then must key the row by that CLAIMED hour — not by whatever
  // hour the (cached, up to ~120s stale) snapshot happens to think it is —
  // or the claimed hour goes unfilled while a different hour dedupes.
  describe("opts.hourUtc override", () => {
    it("keys the row by the passed-in hourUtc, even when it differs from the snapshot's own hour", () => {
      const res = scorableResponse();
      res.snapshot.generatedAt = "2026-09-20T14:58:00.000Z"; // cached snapshot, still hour 14
      const claimedHourUtc = "2026-09-20T15:00:00.000Z"; // but this run claimed hour 15
      const row = rowFromConditions(res, boca, Date.now(), { hourUtc: claimedHourUtc });
      expect(row.hour_utc).toBe(claimedHourUtc);
      // snapshot_generated_at always stays the snapshot's own clock.
      expect(row.snapshot_generated_at).toBe(res.snapshot.generatedAt);
    });

    it("without opts.hourUtc, falls back to the snapshot's own UTC hour (unchanged default behavior)", () => {
      const res = scorableResponse();
      const row = rowFromConditions(res, boca, Date.now());
      expect(row.hour_utc).toBe(hourUtcOf(Date.parse(res.snapshot.generatedAt)));
    });

    it("localizes local_date/local_hour/utc_offset_minutes to the claimed hour, not the snapshot's own instant", () => {
      const res = scorableResponse();
      res.snapshot.generatedAt = "2026-09-20T14:58:00.000Z";
      const claimedHourUtc = "2026-09-20T15:00:00.000Z";
      const row = rowFromConditions(res, boca, Date.now(), { hourUtc: claimedHourUtc });
      const expected = localHourParts(boca.timezone, Date.parse(claimedHourUtc));
      expect(row.local_date).toBe(expected.date);
      expect(row.local_hour).toBe(expected.hour);
      expect(row.utc_offset_minutes).toBe(expected.offsetMinutes);
    });
  });
});

describe("shouldArchiveNow — daylight rule", () => {
  const curated = { slug: "boca-raton", lat: 26.3587, lon: -80.0686, timezone: "America/New_York", tier: "curated" as const };
  const auto = { ...curated, tier: "auto" as const };

  it("curated beaches archive every hour, including the middle of the night", () => {
    const midnightUtc = Date.parse("2026-09-20T05:00:00Z"); // ~1 AM ET, deep night
    expect(shouldArchiveNow(curated, midnightUtc)).toBe(true);
  });

  it("auto beaches only archive in daylight", () => {
    const noonUtc = Date.parse("2026-09-20T17:00:00Z"); // ~1 PM ET, broad daylight
    const midnightUtc = Date.parse("2026-09-20T05:00:00Z"); // ~1 AM ET
    expect(shouldArchiveNow(auto, noonUtc)).toBe(true);
    expect(shouldArchiveNow(auto, midnightUtc)).toBe(false);
  });

  it("agrees with isDaylightAt directly", () => {
    const noonUtc = Date.parse("2026-09-20T17:00:00Z");
    const { date } = localHourParts(auto.timezone, noonUtc);
    expect(isDaylightAt(auto, noonUtc, date)).toBe(shouldArchiveNow(auto, noonUtc));
  });
});

// The archiver builds each beach first in the UTC hour that contains
// (event − 60 min), when the app's sun-color score opens
// (lib/sunForecastWindow.ts). Sun times below come from lib/sources/sun.ts:
// Boca Raton on 2026-11-05 rises 11:32Z and sets 22:35Z, so the forecasts
// open 10:32Z and 21:35Z (hours 10Z and 21Z).
describe("sunWindowPriority — the hour the sun forecast opens", () => {
  const boca = { lat: 26.3587, lon: -80.0686, timezone: "America/New_York" };
  const at = (iso: string) => Date.parse(iso);

  it("is true in the sunset forecast hour, and only that hour", () => {
    expect(sunWindowPriority(boca, at("2026-11-05T21:05:00Z"))).toBe(true); // sunset 90 min ahead
    expect(sunWindowPriority(boca, at("2026-11-05T21:59:00Z"))).toBe(true); // 36 min ahead
    expect(sunWindowPriority(boca, at("2026-11-05T20:59:00Z"))).toBe(false); // the hour before
    expect(sunWindowPriority(boca, at("2026-11-05T22:00:00Z"))).toBe(false); // the hour after
  });

  it("is true in the sunrise forecast hour, still before dawn", () => {
    expect(sunWindowPriority(boca, at("2026-11-05T10:10:00Z"))).toBe(true); // 5:10 AM EST
    expect(sunWindowPriority(boca, at("2026-11-05T11:10:00Z"))).toBe(false);
  });

  it("is false at midday and in the middle of the night", () => {
    expect(sunWindowPriority(boca, at("2026-11-05T17:00:00Z"))).toBe(false);
    expect(sunWindowPriority(boca, at("2026-11-05T05:00:00Z"))).toBe(false);
  });

  it("keeps the same answer for every minute of the hour", () => {
    const start = at("2026-11-05T21:00:00Z");
    for (let min = 0; min < 60; min++) {
      expect(sunWindowPriority(boca, start + min * 60_000)).toBe(true);
    }
  });

  it("uses the beach's local date: Honolulu's sunset falls on the next UTC day", () => {
    // Waikiki, local 2026-11-05: sunset 03:53Z on 11-06, forecast opens 02:53Z.
    // The UTC date (11-06) would give the NEXT evening's sunset instead.
    const waikiki = { lat: 21.27, lon: -157.82, timezone: "Pacific/Honolulu" };
    expect(sunWindowPriority(waikiki, at("2026-11-06T02:10:00Z"))).toBe(true);
    expect(sunWindowPriority(waikiki, at("2026-11-06T03:10:00Z"))).toBe(false);
  });

  it("puts a West Coast sunset forecast in the hour before UTC midnight", () => {
    // Los Angeles, local 2026-11-05: sunset 00:57Z on 11-06, forecast opens 23:57Z on 11-05.
    const la = { lat: 33.9, lon: -118.4, timezone: "America/Los_Angeles" };
    expect(sunWindowPriority(la, at("2026-11-05T23:30:00Z"))).toBe(true);
    expect(sunWindowPriority(la, at("2026-11-06T00:10:00Z"))).toBe(false);
  });

  it("finds an event that belongs to the previous local day's sun", () => {
    // Nome, 2026-06-01: that day's sunset is 09:11Z = 01:11 AM local on 06-02.
    // At 08:30Z (00:30 local, 06-02) it is the forecast hour, but only the
    // 06-01 sun times hold that sunset.
    const nome = { lat: 64.5, lon: -165.4, timezone: "America/Nome" };
    expect(sunWindowPriority(nome, at("2026-06-02T08:30:00Z"))).toBe(true);
  });

  it("is false all day when the sun neither rises nor sets (polar night)", () => {
    const svalbard = { lat: 80, lon: 15, timezone: "Arctic/Longyearbyen" };
    const start = at("2026-12-21T00:00:00Z");
    for (let h = 0; h < 24; h++) {
      expect(sunWindowPriority(svalbard, start + h * 3_600_000)).toBe(false);
    }
  });

  it("is false for an invalid instant", () => {
    expect(sunWindowPriority(boca, NaN)).toBe(false);
  });
});

describe("orderArchiveCandidates — sun-forecast beaches first", () => {
  const ny = { lat: 26.3587, lon: -80.0686, timezone: "America/New_York" };
  const la = { lat: 33.9, lon: -118.4, timezone: "America/Los_Angeles" };
  const c = (slug: string, loc: typeof ny, tier: "curated" | "auto") => ({ slug, ...loc, tier });

  it("admits an auto beach before dawn in its sunrise forecast hour, and puts it first", () => {
    const nowMs = Date.parse("2026-11-05T10:10:00Z"); // 5:10 AM EST — dark in Florida
    const all = [c("a-curated-west", la, "curated"), c("z-auto-east", ny, "auto"), c("b-auto-west", la, "auto")];
    expect(shouldArchiveNow(all[1], nowMs)).toBe(false);
    const out = orderArchiveCandidates(all, new Set(), new Map(), nowMs).map((x) => x.slug);
    // The west-coast auto beach is dark and not in its forecast hour: left out.
    expect(out).toEqual(["z-auto-east", "a-curated-west"]);
  });

  it("sorts sun-forecast beaches ahead of never-archived ones, then keeps the fair order in each group", () => {
    const nowMs = Date.parse("2026-11-05T21:10:00Z"); // Florida sunset forecast hour
    const all = [
      c("never-west", la, "curated"),
      c("old-west", la, "curated"),
      c("new-east", ny, "curated"),
      c("older-east", ny, "curated"),
    ];
    const lastHour = new Map([
      ["old-west", "2026-11-05T10:00:00.000Z"],
      ["new-east", "2026-11-05T20:00:00.000Z"],
      ["older-east", "2026-11-05T15:00:00.000Z"],
    ]);
    const out = orderArchiveCandidates(all, new Set(), lastHour, nowMs).map((x) => x.slug);
    expect(out).toEqual(["older-east", "new-east", "never-west", "old-west"]);
  });

  it("orders the sun group by event time, earliest first, ahead of the fair order", () => {
    const nowMs = Date.parse("2026-11-05T21:10:00Z");
    // Nags Head sets 22:02Z, Boca Raton 22:35Z: both forecasts open in hour 21Z.
    const nags = getLocation("nags-head")!;
    const boca = getLocation("boca-raton")!;
    const all = [c("boca-raton", boca, "curated"), c("nags-head", nags, "curated")];
    // Boca has never been archived, so the fair order alone would put it first.
    const lastHour = new Map([["nags-head", "2026-11-05T20:00:00.000Z"]]);
    const out = orderArchiveCandidates(all, new Set(), lastHour, nowMs);
    expect(out.map((x) => x.slug)).toEqual(["nags-head", "boca-raton"]);
    expect(out[0].sunEventMs).toBe(sunWindowEventMs(nags, nowMs));
    expect(out[0].sunEventMs!).toBeLessThan(out[1].sunEventMs!);
  });

  it("marks only sun-forecast candidates with sunEventMs", () => {
    const nowMs = Date.parse("2026-11-05T21:10:00Z");
    const out = orderArchiveCandidates([c("east", ny, "curated"), c("west", la, "curated")], new Set(), new Map(), nowMs);
    expect(out.find((x) => x.slug === "east")!.sunEventMs).toBe(Date.parse("2026-11-05T22:35:24.599Z"));
    expect("sunEventMs" in out.find((x) => x.slug === "west")!).toBe(false);
  });

  it("still drops a sun-forecast beach that already has a row this hour", () => {
    const nowMs = Date.parse("2026-11-05T21:10:00Z");
    const out = orderArchiveCandidates([c("east", ny, "curated")], new Set(["east"]), new Map(), nowMs);
    expect(out).toEqual([]);
  });
});

// The archiver keeps back budget for the sun builds still due today
// (app/api/history/archive/route.ts). The count must follow the same rule as
// sunWindowPriority, so these tests check it against that function hour by hour.
describe("sunBuildsDueToday — sun builds left in the UTC day", () => {
  const HOUR = 3_600_000;
  const locs = listLocations();
  const at = (iso: string) => Date.parse(iso);

  /** Brute force: for each remaining hour of the UTC day, the beaches in their forecast hour. */
  function bruteForce(list: typeof locs, nowMs: number): number {
    const first = Math.floor(nowMs / HOUR);
    const dayEnd = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate() + 1) / HOUR;
    let n = 0;
    for (let h = first; h < dayEnd; h++) for (const l of list) if (sunWindowPriority(l, h * HOUR + 30 * 60_000)) n++;
    return n;
  }

  it("is two per beach (126 for 63 beaches) at the start of an ordinary UTC day", () => {
    expect(locs.length).toBe(63);
    expect(sunBuildsDueToday(locs, at("2026-11-05T00:00:00Z"), null)).toBe(126);
    expect(sunBuildsDueToday(locs, at("2026-11-05T00:00:00Z"), null)).toBe(bruteForce(locs, at("2026-11-05T00:00:00Z")));
  });

  it("is small late in the day: only the West Coast and Hawaii sunsets are left", () => {
    const n = sunBuildsDueToday(locs, at("2026-11-05T23:10:00Z"), null);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(15);
    expect(n).toBe(bruteForce(locs, at("2026-11-05T23:10:00Z")));
  });

  it("matches sunWindowPriority hour by hour through the day", () => {
    for (const iso of ["2026-11-05T05:00:00Z", "2026-11-05T12:00:00Z", "2026-11-05T21:10:00Z"]) {
      expect(sunBuildsDueToday(locs, at(iso), null)).toBe(bruteForce(locs, at(iso)));
    }
  });

  it("counts a current-hour beach only while it has no row yet", () => {
    const nowMs = at("2026-11-05T21:10:00Z");
    const inWindow = locs.filter((l) => sunWindowPriority(l, nowMs)).map((l) => l.slug);
    expect(inWindow.length).toBeGreaterThan(1);
    const all = sunBuildsDueToday(locs, nowMs, null);
    // Every beach in its forecast hour already archived: none of them count.
    expect(sunBuildsDueToday(locs, nowMs, new Set())).toBe(all - inWindow.length);
    // One of them still pending: it counts.
    expect(sunBuildsDueToday(locs, nowMs, new Set([inWindow[0]]))).toBe(all - inWindow.length + 1);
  });

  it("gives Huntington Beach three sun builds on 2026-11-01 (DST ends), two the day after", () => {
    // UTC 11-01 holds the 10-31 sunset (forecast 00Z), the sunrise (13Z) and
    // the 11-01 sunset at 00:5xZ on 11-02, whose forecast opens at 23:5xZ.
    const hb = getLocation("huntington-beach")!;
    expect(sunBuildsDueToday([hb], at("2026-11-01T00:00:00Z"), null)).toBe(3);
    expect(sunBuildsDueToday([hb], at("2026-11-02T00:00:00Z"), null)).toBe(2);
    expect(sunBuildsDueToday([hb], at("2026-11-01T00:00:00Z"), null)).toBe(bruteForce([hb], at("2026-11-01T00:00:00Z")));
  });

  it("follows the same rule on both DST days for every beach", () => {
    for (const iso of ["2026-11-01T00:00:00Z", "2026-11-01T09:30:00Z", "2026-03-08T00:00:00Z", "2026-03-08T07:30:00Z"]) {
      expect(sunBuildsDueToday(locs, at(iso), null)).toBe(bruteForce(locs, at(iso)));
    }
    expect(sunBuildsDueToday(locs, at("2026-11-01T00:00:00Z"), null)).toBe(127); // 126 + Huntington's extra
  });

  it("is zero for an invalid instant and with no beaches", () => {
    expect(sunBuildsDueToday(locs, NaN, null)).toBe(0);
    expect(sunBuildsDueToday([], at("2026-11-05T00:00:00Z"), null)).toBe(0);
  });

  it("stays cheap: well under 10 ms for all 63 beaches", () => {
    const t0 = performance.now();
    sunBuildsDueToday(locs, at("2027-01-15T00:00:00Z"), null); // cold dates
    expect(performance.now() - t0).toBeLessThan(10);
  });
});
