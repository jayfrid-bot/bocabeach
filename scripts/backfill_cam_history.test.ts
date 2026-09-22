import { describe, it, expect } from "vitest";
import {
  feedUrlFor,
  insertSqlFor,
  parseCapturedAtUtc,
  rowFromHistoryEntry,
} from "./backfill_cam_history.mjs";

describe("parseCapturedAtUtc", () => {
  it("converts an offset-bearing local timestamp to UTC ISO", () => {
    // "2026-06-04T13:00-04:00" (EDT) = 17:00 UTC.
    expect(parseCapturedAtUtc("2026-06-04T13:00-04:00")).toBe("2026-06-04T17:00:00.000Z");
  });

  it("handles a Z-suffixed timestamp unchanged (already UTC)", () => {
    expect(parseCapturedAtUtc("2026-06-04T17:00:00.000Z")).toBe("2026-06-04T17:00:00.000Z");
  });

  it("returns null for garbage or missing input", () => {
    expect(parseCapturedAtUtc("not-a-date")).toBeNull();
    expect(parseCapturedAtUtc(undefined)).toBeNull();
    expect(parseCapturedAtUtc("")).toBeNull();
  });
});

describe("feedUrlFor", () => {
  it("uses the legacy single-file feed for boca-raton", () => {
    expect(feedUrlFor("boca-raton")).toMatch(/\/cam_seaweed\.json$/);
  });

  it("uses the per-beach file for every other slug", () => {
    expect(feedUrlFor("deerfield-beach")).toMatch(/\/cam_seaweed\.deerfield-beach\.json$/);
  });
});

describe("rowFromHistoryEntry", () => {
  it("maps a feed history entry to a cam_observations row", () => {
    const row = rowFromHistoryEntry("boca-raton", {
      t: "2026-06-04T13:00-04:00",
      seaweed: "moderate",
      cov: 42,
      people: 30,
      crowdPct: 55,
      water: "murky",
      clr: 20,
    });
    expect(row).toMatchObject({
      slug: "boca-raton",
      captured_at_utc: "2026-06-04T17:00:00.000Z",
      crowd_pct: 55,
      people: 30,
      seaweed_level: "moderate",
      cov_pct: 42,
      clarity_pct: 20,
      water_word: "murky",
      uw_pct: null,
      source: "feed",
    });
    expect(JSON.parse(row!.raw_json)).toMatchObject({ seaweed: "moderate" });
  });

  it("skips an entry with no usable capture time", () => {
    expect(rowFromHistoryEntry("boca-raton", { seaweed: "low" })).toBeNull();
    expect(rowFromHistoryEntry("boca-raton", { t: "garbage" })).toBeNull();
  });

  it("never sets a beach_hourly-only field or fabricates a score", () => {
    const row = rowFromHistoryEntry("boca-raton", { t: "2026-06-04T13:00-04:00" });
    expect(row).not.toHaveProperty("score");
    expect(row).not.toHaveProperty("hour_utc");
  });
});

describe("insertSqlFor", () => {
  it("emits an idempotent INSERT OR IGNORE with escaped values", () => {
    const row = rowFromHistoryEntry("boca-raton", {
      t: "2026-06-04T13:00-04:00",
      water: "O'Brien's",
    })!;
    const sql = insertSqlFor(row);
    expect(sql).toMatch(/^INSERT OR IGNORE INTO cam_observations/);
    expect(sql).toContain("O''Brien''s");
    expect(sql.trim().endsWith(";")).toBe(true);
  });
});
