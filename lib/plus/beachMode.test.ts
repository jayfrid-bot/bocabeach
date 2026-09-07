import { describe, it, expect } from "vitest";
import {
  AT_BEACH_MI,
  MAX_ARM_MS,
  SUPPRESSION_MAX_AGE_MS,
  extendArmedUntil,
  isSuppressed,
  resolveArmCoords,
  resolveBeachModeView,
  shouldClearSuppression,
} from "@/lib/plus/beachMode";

const NOW = Date.parse("2026-09-02T16:00:00Z");
const HOUR = 3_600_000;

// A beach at (26.35, -80.08); "near" and "far" fixes relative to it.
const BEACH = { lat: 26.35, lon: -80.08 };
const NEAR_FIX = { lat: 26.351, lon: -80.081 }; // well under 2mi
const FAR_FIX = { lat: 26.6, lon: -80.3 }; // tens of miles away

describe("extendArmedUntil", () => {
  it("starts a fresh window at now + duration when nothing is armed", () => {
    expect(extendArmedUntil(0, NOW, 4 * HOUR)).toBe(NOW + 4 * HOUR);
  });

  it("never shortens an existing window — Extend after a 6h manual arm", () => {
    // Regression for issue #9: a 6h manual window followed immediately by an
    // Extend (which asks for 4h) must not roll the clock back two hours.
    const sixHourWindow = NOW + 6 * HOUR;
    expect(extendArmedUntil(sixHourWindow, NOW, 4 * HOUR)).toBe(sixHourWindow);
  });

  it("does extend when the new duration actually reaches further", () => {
    const almostDone = NOW + 10 * 60_000;
    expect(extendArmedUntil(almostDone, NOW, 4 * HOUR)).toBe(NOW + 4 * HOUR);
  });

  it("stacking near the cap does not push past it — the later-wins max still respects the ceiling", () => {
    const nearlyMax = NOW + MAX_ARM_MS - 60_000;
    // "Never shortens" wins here: the existing window (7h59m out) already
    // beats now + 4h, so it is kept as-is rather than rounded up to the cap.
    expect(extendArmedUntil(nearlyMax, NOW, 4 * HOUR)).toBe(nearlyMax);
  });

  it("clamps an over-cap existing value down to the cap", () => {
    // Defensive: even if `currentArmedUntil` were somehow already past what
    // the server would ever grant, the optimistic UI must not propose more.
    const overCap = NOW + MAX_ARM_MS + HOUR;
    expect(extendArmedUntil(overCap, NOW, 4 * HOUR)).toBe(NOW + MAX_ARM_MS);
  });
});

describe("shouldClearSuppression / isSuppressed", () => {
  const suppression = { slug: "delray", since: NOW, lat: BEACH.lat, lon: BEACH.lon };

  it("is honored while the phone is still near the spot it was turned off at", () => {
    expect(isSuppressed(suppression, "delray", NOW + HOUR, NEAR_FIX)).toBe(true);
    expect(shouldClearSuppression(suppression, NOW + HOUR, NEAR_FIX)).toBe(false);
  });

  it("clears once a fix shows the phone has actually left", () => {
    expect(shouldClearSuppression(suppression, NOW + HOUR, FAR_FIX)).toBe(true);
    expect(isSuppressed(suppression, "delray", NOW + HOUR, FAR_FIX)).toBe(false);
  });

  it("clears after 24h even if the phone never left", () => {
    const justUnder = NOW + SUPPRESSION_MAX_AGE_MS - 1000;
    const atOrOver = NOW + SUPPRESSION_MAX_AGE_MS;
    expect(shouldClearSuppression(suppression, justUnder, NEAR_FIX)).toBe(false);
    expect(shouldClearSuppression(suppression, atOrOver, NEAR_FIX)).toBe(true);
    expect(isSuppressed(suppression, "delray", atOrOver, NEAR_FIX)).toBe(false);
  });

  it("with no fresher fix, only age can clear it — never assumed to have left", () => {
    expect(shouldClearSuppression(suppression, NOW + HOUR, null)).toBe(false);
    expect(isSuppressed(suppression, "delray", NOW + HOUR, null)).toBe(true);
  });

  it("never suppresses a different beach", () => {
    expect(isSuppressed(suppression, "boca-raton", NOW + HOUR, NEAR_FIX)).toBe(false);
  });

  it("a manual On clears the suppression (no suppression → never honored)", () => {
    // BeachModeCard writes the suppression to null on a manual arm before the
    // network call; once storage holds null, isSuppressed has nothing to key
    // off and auto-arm is unblocked immediately.
    expect(isSuppressed(null, "delray", NOW + HOUR, NEAR_FIX)).toBe(false);
  });
});

describe("resolveArmCoords", () => {
  const fix = { lat: NEAR_FIX.lat, lon: NEAR_FIX.lon, accuracyM: 12, at: NOW };

  it("auto-arm always uses the phone's own fix", () => {
    expect(resolveArmCoords("auto", fix, BEACH)).toEqual({
      lat: fix.lat,
      lon: fix.lon,
      accuracyM: fix.accuracyM,
      fixAt: fix.at,
    });
  });

  it("manual arm near the target beach uses the fix too", () => {
    expect(resolveArmCoords("manual", fix, BEACH)).toEqual({
      lat: fix.lat,
      lon: fix.lon,
      accuracyM: fix.accuracyM,
      fixAt: fix.at,
    });
  });

  it("manual arm of a beach the phone is NOT near sends no coordinates — the server falls back to the centroid", () => {
    const farAwayFix = { lat: FAR_FIX.lat, lon: FAR_FIX.lon, accuracyM: 12, at: NOW };
    expect(resolveArmCoords("manual", farAwayFix, BEACH)).toEqual({
      lat: null,
      lon: null,
      accuracyM: null,
      fixAt: null,
    });
  });

  it("with no fix at all, sends nothing regardless of source", () => {
    expect(resolveArmCoords("auto", null, BEACH)).toEqual({ lat: null, lon: null, accuracyM: null, fixAt: null });
    expect(resolveArmCoords("manual", null, BEACH)).toEqual({ lat: null, lon: null, accuracyM: null, fixAt: null });
  });

  it("respects the shared AT_BEACH_MI radius at the boundary", () => {
    // A fix exactly on the beach's centroid is trivially "near".
    const onBeach = { lat: BEACH.lat, lon: BEACH.lon, accuracyM: 5, at: NOW };
    expect(resolveArmCoords("manual", onBeach, BEACH).lat).toBe(BEACH.lat);
    expect(AT_BEACH_MI).toBeGreaterThan(0);
  });
});

describe("resolveBeachModeView", () => {
  it("the door outranks everything else — a cached 'not entitled' wins immediately", () => {
    expect(
      resolveBeachModeView({ entitled: false, locked: false, deviceLoaded: false, armed: true }),
    ).toBe("door");
    expect(resolveBeachModeView({ entitled: true, locked: true, deviceLoaded: true, armed: true })).toBe(
      "door",
    );
  });

  it("shows loading once entitled but before the device row has been fetched", () => {
    expect(
      resolveBeachModeView({ entitled: true, locked: false, deviceLoaded: false, armed: false }),
    ).toBe("loading");
    expect(
      resolveBeachModeView({ entitled: true, locked: false, deviceLoaded: false, armed: true }),
    ).toBe("loading");
  });

  it("shows armed or idle once the device row has loaded", () => {
    expect(resolveBeachModeView({ entitled: true, locked: false, deviceLoaded: true, armed: true })).toBe(
      "armed",
    );
    expect(resolveBeachModeView({ entitled: true, locked: false, deviceLoaded: true, armed: false })).toBe(
      "idle",
    );
  });
});
