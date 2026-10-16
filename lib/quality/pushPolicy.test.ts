import { describe, expect, it } from "vitest";
import {
  decidePush,
  DEDUPE_WINDOW_MS,
  inQuietHours,
  isWatched,
  MAX_PUSHES_PER_DAY,
  ownerDayKey,
  ownerDayStartMs,
  pushEligibility,
  watchedSlugs,
} from "@/lib/quality/pushPolicy";
import { endOfLocalDayMs, localMidnightMs, startOfLocalDayMs } from "@/lib/quality/localDay";

const at = (iso: string) => Date.parse(iso);

describe("inQuietHours (America/New_York, 9 PM to 7 AM)", () => {
  // October: EDT, UTC-4.
  it("is quiet from 9 PM and until 7 AM, and awake in between", () => {
    expect(inQuietHours(at("2026-10-14T00:59:00Z"))).toBe(false); // 8:59 PM
    expect(inQuietHours(at("2026-10-14T01:00:00Z"))).toBe(true); // 9:00 PM
    expect(inQuietHours(at("2026-10-14T06:00:00Z"))).toBe(true); // 2:00 AM
    expect(inQuietHours(at("2026-10-14T10:59:00Z"))).toBe(true); // 6:59 AM
    expect(inQuietHours(at("2026-10-14T11:00:00Z"))).toBe(false); // 7:00 AM
    expect(inQuietHours(at("2026-10-14T17:20:00Z"))).toBe(false); // 1:20 PM
  });

  it("follows the clock change: in January 7 AM is 12:00 UTC", () => {
    expect(inQuietHours(at("2027-01-14T11:00:00Z"))).toBe(true); // 6:00 AM EST
    expect(inQuietHours(at("2027-01-14T12:00:00Z"))).toBe(false); // 7:00 AM EST
  });
});

describe("the owner's day", () => {
  it("starts at local midnight", () => {
    expect(ownerDayStartMs(at("2026-10-14T15:00:00Z"))).toBe(at("2026-10-14T04:00:00Z"));
    expect(ownerDayStartMs(at("2026-10-14T03:59:00Z"))).toBe(at("2026-10-13T04:00:00Z")); // 11:59 PM the night before
  });

  it("survives both clock changes", () => {
    // Fall back, Nov 1 2026: the day starts at midnight EDT and lasts 25 hours.
    expect(ownerDayStartMs(at("2026-11-01T20:00:00Z"))).toBe(at("2026-11-01T04:00:00Z"));
    expect(ownerDayStartMs(at("2026-11-02T06:00:00Z"))).toBe(at("2026-11-02T05:00:00Z"));
    // Spring forward, Mar 14 2027: midnight is still EST.
    expect(ownerDayStartMs(at("2027-03-14T20:00:00Z"))).toBe(at("2027-03-14T05:00:00Z"));
  });
});

describe("ownerDayKey and pushEligibility", () => {
  it("the day key is the owner's calendar date, not UTC's", () => {
    expect(ownerDayKey(at("2026-10-14T03:59:00Z"))).toBe("2026-10-13"); // 11:59 PM EDT
    expect(ownerDayKey(at("2026-10-14T04:00:00Z"))).toBe("2026-10-14");
    expect(ownerDayKey(at("2026-11-02T04:30:00Z"))).toBe("2026-11-01"); // 11:30 PM EST, the night of the clock change
  });

  it("only the two rules that need no database: watched beach, waking hours", () => {
    const noon = at("2026-10-14T16:00:00Z");
    expect(pushEligibility(noon, "boca-raton")).toBe("ok");
    expect(pushEligibility(noon, "miami-beach")).toBe("unwatched");
    expect(pushEligibility(at("2026-10-14T03:00:00Z"), "boca-raton")).toBe("quiet-hours");
    expect(pushEligibility(at("2026-10-14T03:00:00Z"), "miami-beach")).toBe("unwatched");
    expect(pushEligibility(noon, "x", () => true)).toBe("ok");
  });
});

describe("localDay helpers", () => {
  const NY = "America/New_York";
  it("start and end of the local day", () => {
    expect(startOfLocalDayMs(NY, at("2026-10-14T15:00:00Z"))).toBe(at("2026-10-14T04:00:00Z"));
    expect(endOfLocalDayMs(NY, at("2026-10-14T15:00:00Z"))).toBe(at("2026-10-15T04:00:00Z"));
    expect(localMidnightMs(NY, "2026-10-14")).toBe(at("2026-10-14T04:00:00Z"));
  });

  it("a day with a clock change is 25 or 23 hours long", () => {
    const fall = endOfLocalDayMs(NY, at("2026-11-01T12:00:00Z")) - startOfLocalDayMs(NY, at("2026-11-01T12:00:00Z"));
    expect(fall).toBe(25 * 3_600_000);
    const spring = endOfLocalDayMs(NY, at("2027-03-14T18:00:00Z")) - startOfLocalDayMs(NY, at("2027-03-14T18:00:00Z"));
    expect(spring).toBe(23 * 3_600_000);
  });

  it("works for a beach in another zone", () => {
    expect(endOfLocalDayMs("America/Los_Angeles", at("2026-10-14T20:00:00Z"))).toBe(at("2026-10-15T07:00:00Z"));
  });
});

describe("watched beaches", () => {
  it("are boca-raton plus every vision-cam beach", () => {
    expect(watchedSlugs().sort()).toEqual(["boca-raton", "deerfield-beach", "fort-lauderdale", "fort-myers-beach", "pensacola-beach"]);
    expect(isWatched("deerfield-beach")).toBe(true);
    expect(isWatched("miami-beach")).toBe(false);
  });
});

describe("decidePush", () => {
  const NOON = at("2026-10-14T16:00:00Z"); // noon EDT
  const base = { nowMs: NOON, slug: "boca-raton", pushedToday: 0, lastPushedSameKeyMs: null };

  it("pushes by default", () => {
    expect(decidePush(base)).toEqual({ push: true, reason: "ok" });
  });

  it("an unwatched beach is stored, not pushed", () => {
    expect(decidePush({ ...base, slug: "miami-beach" })).toEqual({ push: false, reason: "unwatched" });
  });

  it("nothing pushes in quiet hours", () => {
    expect(decidePush({ ...base, nowMs: at("2026-10-14T03:00:00Z") })).toEqual({ push: false, reason: "quiet-hours" });
  });

  it("the same beach and signal is not pushed twice inside 3 hours", () => {
    expect(decidePush({ ...base, lastPushedSameKeyMs: NOON - DEDUPE_WINDOW_MS + 1 })).toEqual({ push: false, reason: "duplicate" });
    expect(decidePush({ ...base, lastPushedSameKeyMs: NOON - DEDUPE_WINDOW_MS })).toEqual({ push: true, reason: "ok" });
  });

  it("at most 3 a day", () => {
    expect(MAX_PUSHES_PER_DAY).toBe(3);
    expect(decidePush({ ...base, pushedToday: 2 }).push).toBe(true);
    expect(decidePush({ ...base, pushedToday: 3 })).toEqual({ push: false, reason: "daily-cap" });
  });

  it("checks in a fixed order: unwatched, quiet, duplicate, cap", () => {
    const all = { nowMs: at("2026-10-14T03:00:00Z"), slug: "miami-beach", pushedToday: 9, lastPushedSameKeyMs: at("2026-10-14T02:00:00Z") };
    expect(decidePush(all).reason).toBe("unwatched");
    expect(decidePush({ ...all, slug: "boca-raton" }).reason).toBe("quiet-hours");
    expect(decidePush({ ...all, slug: "boca-raton", nowMs: NOON, lastPushedSameKeyMs: NOON - 1000 }).reason).toBe("duplicate");
    expect(decidePush({ ...all, slug: "boca-raton", nowMs: NOON, lastPushedSameKeyMs: null }).reason).toBe("daily-cap");
  });

  it("accepts a custom watch list (tests)", () => {
    expect(decidePush({ ...base, slug: "x", watched: () => true }).push).toBe(true);
  });
});
