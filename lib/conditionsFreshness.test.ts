import { describe, it, expect } from "vitest";
import {
  shouldRefetchForFreshness,
  shouldRevalidateOnMount,
  MOUNT_REVALIDATE_AFTER_MS,
  CONDITIONS_MAX_STALE_MS,
  FRESHNESS_MAX_ATTEMPTS,
  isOlderSnapshot,
} from "@/lib/conditionsFreshness";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

describe("shouldRevalidateOnMount", () => {
  it("trusts a snapshot the server rendered moments ago", () => {
    expect(shouldRevalidateOnMount(new Date(NOW - 5_000).toISOString(), NOW)).toBe(false);
    expect(shouldRevalidateOnMount(new Date(NOW - MOUNT_REVALIDATE_AFTER_MS).toISOString(), NOW)).toBe(false);
  });

  it("asks again once the snapshot is older than the window", () => {
    expect(shouldRevalidateOnMount(new Date(NOW - MOUNT_REVALIDATE_AFTER_MS - 1).toISOString(), NOW)).toBe(true);
    expect(shouldRevalidateOnMount(new Date(NOW - 45 * 60_000).toISOString(), NOW)).toBe(true);
  });

  it("asks when it cannot tell how old the snapshot is", () => {
    expect(shouldRevalidateOnMount("not-a-date", NOW)).toBe(true);
  });

  it("stays well inside the staleness the page already tolerates", () => {
    expect(MOUNT_REVALIDATE_AFTER_MS).toBeLessThan(CONDITIONS_MAX_STALE_MS);
  });
});

describe("a stored page (edge cache or service worker) and the mount refetch", () => {
  it("a page stored a moment ago whose snapshot is 9 minutes old still refreshes", () => {
    // The edge cache can serve a page up to 10 minutes after it rendered, with data up to
    // 30 minutes old. The rule reads the snapshot's own time, so the copy's age does not hide it.
    expect(shouldRevalidateOnMount(new Date(NOW - 9 * 60_000).toISOString(), NOW)).toBe(true);
  });

  it("the dashboard feeds the rule the snapshot time from the HTML, not a response time", () => {
    const src = readFileSync(join(__dirname, "..", "components/ConditionsDashboard.tsx"), "utf8");
    expect(src).toMatch(/shouldRevalidateOnMount\(initial\.snapshot\.generatedAt, Date\.now\(\)\)/);
    expect(src).not.toMatch(/x-edge-age|x-edge-data-age|x-ibd-cached-at/);
  });
});

describe("isOlderSnapshot", () => {
  const at = (iso: string) => ({ snapshot: { generatedAt: iso } });
  it("is true only when the incoming snapshot is strictly older", () => {
    expect(isOlderSnapshot(at("2026-10-18T10:00:00Z"), at("2026-10-18T10:05:00Z"))).toBe(true);
    expect(isOlderSnapshot(at("2026-10-18T10:05:00Z"), at("2026-10-18T10:05:00Z"))).toBe(false);
    expect(isOlderSnapshot(at("2026-10-18T10:06:00Z"), at("2026-10-18T10:05:00Z"))).toBe(false);
  });
  it("never blocks an answer it cannot date", () => {
    expect(isOlderSnapshot(at("bad"), at("2026-10-18T10:05:00Z"))).toBe(false);
    expect(isOlderSnapshot(at("2026-10-18T10:00:00Z"), at("bad"))).toBe(false);
    expect(isOlderSnapshot(null, at("2026-10-18T10:05:00Z"))).toBe(false);
    expect(isOlderSnapshot({}, undefined)).toBe(false);
  });
});
