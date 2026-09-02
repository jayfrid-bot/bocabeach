import { describe, expect, it } from "vitest";
import {
  CACHE_MAX_AGE_MS,
  cacheFromDevice,
  entitlementRemaining,
  isEntitled,
  shouldRefresh,
} from "@/lib/plus/entitlement";
import type { DeviceRecord } from "@/lib/db/types";
import { defaultPrefs } from "@/lib/db/types";
import type { PlusCache } from "@/lib/plus/types";

const NOW = Date.parse("2026-09-02T15:00:00Z");
const DAY = 86_400_000;

function cache(over: Partial<PlusCache> = {}): PlusCache {
  return { plan: "plus", until: NOW + DAY, checkedAt: NOW, ...over };
}

function device(over: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    platform: "ios",
    tz: "America/New_York",
    homeSlug: null,
    profile: null,
    prefs: defaultPrefs(),
    plan: "free",
    entitlementUntil: null,
    trialUsed: false,
    previewSeen: false,
    presence: null,
    ...over,
  };
}

describe("isEntitled", () => {
  it("is true for a plus plan that has not run out", () => {
    expect(isEntitled(cache(), NOW)).toBe(true);
  });

  it("is false with no cache at all", () => {
    expect(isEntitled(null, NOW)).toBe(false);
  });

  it("is false on a free plan, even with an entitlement date", () => {
    expect(isEntitled(cache({ plan: "free" }), NOW)).toBe(false);
  });

  it("is false the moment the entitlement expires", () => {
    expect(isEntitled(cache({ until: NOW }), NOW)).toBe(false);
    expect(isEntitled(cache({ until: NOW + 1 }), NOW)).toBe(true);
  });

  it("is false when a trial ends while the app is open", () => {
    const trial = cache({ until: NOW + 3 * DAY });
    expect(isEntitled(trial, NOW)).toBe(true);
    expect(isEntitled(trial, NOW + 3 * DAY + 1)).toBe(false);
  });

  it("does not need a fresh cache — an expiry date is its own limit", () => {
    expect(isEntitled(cache({ checkedAt: NOW - 30 * DAY }), NOW)).toBe(true);
  });
});

describe("shouldRefresh", () => {
  it("stays quiet for a device the server has never seen", () => {
    expect(shouldRefresh(null, NOW)).toBe(false);
  });

  it("trusts a cache younger than six hours", () => {
    expect(shouldRefresh(cache({ checkedAt: NOW - CACHE_MAX_AGE_MS + 1000 }), NOW)).toBe(false);
  });

  it("re-checks once the cache passes six hours", () => {
    expect(shouldRefresh(cache({ checkedAt: NOW - CACHE_MAX_AGE_MS }), NOW)).toBe(true);
  });

  it("re-checks when the clock moved backwards, so a cache can never freeze", () => {
    expect(shouldRefresh(cache({ checkedAt: NOW + DAY }), NOW)).toBe(true);
  });
});

describe("cacheFromDevice", () => {
  it("copies the plan and expiry and stamps the read time", () => {
    const rec = device({ plan: "plus", entitlementUntil: NOW + DAY });
    expect(cacheFromDevice(rec, NOW)).toEqual({ plan: "plus", until: NOW + DAY, checkedAt: NOW });
  });

  it("turns a missing expiry into null rather than undefined", () => {
    expect(cacheFromDevice(device(), NOW).until).toBeNull();
  });
});

describe("entitlementRemaining", () => {
  it("says nothing when there is nothing to say", () => {
    expect(entitlementRemaining(null, NOW)).toBeNull();
    expect(entitlementRemaining(cache({ plan: "free" }), NOW)).toBeNull();
  });

  it("counts whole days once there is more than one", () => {
    expect(entitlementRemaining(cache({ until: NOW + 3 * DAY }), NOW)).toBe("3 days left");
  });

  it("does not shortchange a trial the second it starts", () => {
    // 3 days minus a heartbeat is still a 3-day trial.
    expect(entitlementRemaining(cache({ until: NOW + 3 * DAY - 2000 }), NOW)).toBe("3 days left");
  });

  it("does not say '1 days'", () => {
    expect(entitlementRemaining(cache({ until: NOW + DAY + 1000 }), NOW)).toBe("1 day left");
  });

  it("falls back to hours on the last day", () => {
    expect(entitlementRemaining(cache({ until: NOW + 5 * 3_600_000 }), NOW)).toBe("5 hours left");
    expect(entitlementRemaining(cache({ until: NOW + 60_000 }), NOW)).toBe("1 hour left");
  });
});
