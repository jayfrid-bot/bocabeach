import { describe, it, expect } from "vitest";
import {
  shouldRefetchForFreshness,
  CONDITIONS_MAX_STALE_MS,
  FRESHNESS_MAX_ATTEMPTS,
} from "@/lib/conditionsFreshness";

const NOW = Date.parse("2026-09-23T12:00:00.000Z");

describe("shouldRefetchForFreshness", () => {
  it("says no while the snapshot is within the stale tolerance", () => {
    const generatedAt = new Date(NOW - (CONDITIONS_MAX_STALE_MS - 1000)).toISOString();
    expect(shouldRefetchForFreshness(generatedAt, NOW, 0)).toBe(false);
  });

  it("says yes once the snapshot is older than the tolerance, with attempts left", () => {
    const generatedAt = new Date(NOW - (CONDITIONS_MAX_STALE_MS + 1000)).toISOString();
    expect(shouldRefetchForFreshness(generatedAt, NOW, 0)).toBe(true);
    expect(shouldRefetchForFreshness(generatedAt, NOW, 1)).toBe(true);
  });

  it("says no once attempts are exhausted, however stale", () => {
    const generatedAt = new Date(NOW - 24 * 3600_000).toISOString(); // a day old
    expect(shouldRefetchForFreshness(generatedAt, NOW, FRESHNESS_MAX_ATTEMPTS)).toBe(false);
    expect(shouldRefetchForFreshness(generatedAt, NOW, FRESHNESS_MAX_ATTEMPTS + 1)).toBe(false);
  });

  it("uses a fixed, exact boundary — exactly at the tolerance is NOT yet stale", () => {
    const generatedAt = new Date(NOW - CONDITIONS_MAX_STALE_MS).toISOString();
    expect(shouldRefetchForFreshness(generatedAt, NOW, 0)).toBe(false);
  });

  it("treats an unparseable timestamp as never worth retrying", () => {
    expect(shouldRefetchForFreshness("not-a-date", NOW, 0)).toBe(false);
  });
});
