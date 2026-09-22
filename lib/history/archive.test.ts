import { describe, it, expect } from "vitest";
import { getLocation } from "@/config/locations";
import { scorableResponse } from "@/lib/alerts/fixtures";
import {
  coverageTier,
  hourUtcOf,
  isDaylightAt,
  localHourParts,
  rowFromConditions,
  shouldArchiveNow,
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
