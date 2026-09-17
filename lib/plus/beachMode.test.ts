import { describe, it, expect } from "vitest";
import {
  AT_BEACH_MI,
  MAX_ARM_MS,
  PRESENCE_REFRESH_MS,
  SUPPRESSION_MAX_AGE_MS,
  coarsePosition,
  decideArm,
  establishesArrival,
  extendArmedUntil,
  isSuppressed,
  resolveArmCoords,
  resolveBeachModeView,
  resolveDelivery,
  shouldClearSuppression,
  shouldRefreshPresence,
  shouldRetarget,
} from "@/lib/plus/beachMode";
import { ARRIVAL_MAX_FIX_AGE_MS, FIX_MAX_ACCURACY_M } from "@/lib/location/device";
import type { LocationPublic } from "@/lib/types";

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

  it("still holds for a different nearest beach while the phone has not moved (keyed on the position too)", () => {
    // Off while armed for delray, standing nearer boca: the phone is still at
    // the spot Off was tapped, so boca must not auto-arm a second later.
    expect(isSuppressed(suppression, "boca-raton", NOW + HOUR, NEAR_FIX)).toBe(true);
  });

  it("does not suppress a different beach once the phone is somewhere else", () => {
    expect(isSuppressed(suppression, "boca-raton", NOW + HOUR, FAR_FIX)).toBe(false);
  });

  it("without a fix, only the named beach is suppressed", () => {
    expect(isSuppressed(suppression, "boca-raton", NOW + HOUR, null)).toBe(false);
    expect(isSuppressed(suppression, "delray", NOW + HOUR, null)).toBe(true);
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

  it("auto-arm uses the phone's own fix when it is at the beach", () => {
    expect(resolveArmCoords("auto", fix, BEACH)).toEqual({
      lat: fix.lat,
      lon: fix.lon,
      accuracyM: fix.accuracyM,
      fixAt: fix.at,
    });
  });

  it("auto-arm gets the SAME proximity gate as manual — home coordinates are never forwarded (LOC-04)", () => {
    const home = { lat: FAR_FIX.lat, lon: FAR_FIX.lon, accuracyM: 12, at: NOW };
    expect(resolveArmCoords("auto", home, BEACH)).toEqual({ lat: null, lon: null, accuracyM: null, fixAt: null });
  });

  it("a fix too fuzzy to place the phone sends no coordinates, whatever the source (LOC-12)", () => {
    const fuzzy = { ...fix, accuracyM: FIX_MAX_ACCURACY_M + 1 };
    expect(resolveArmCoords("auto", fuzzy, BEACH).lat).toBeNull();
    expect(resolveArmCoords("manual", fuzzy, BEACH).lat).toBeNull();
    expect(resolveArmCoords("manual", { ...fix, accuracyM: FIX_MAX_ACCURACY_M }, BEACH).lat).toBe(fix.lat);
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

describe("coarsePosition", () => {
  it("keeps two decimals, so a suppression stores a neighborhood and not a raw fix", () => {
    expect(coarsePosition(26.351234, -80.081987)).toEqual({ lat: 26.35, lon: -80.08 });
  });
});

describe("establishesArrival (LOC-12, LOC-06)", () => {
  const good = { lat: NEAR_FIX.lat, lon: NEAR_FIX.lon, accuracyM: 20, at: NOW };

  it("needs near, precise AND recent — all three", () => {
    expect(establishesArrival(good, BEACH, NOW)).toBe(true);
    expect(establishesArrival({ ...good, lat: FAR_FIX.lat, lon: FAR_FIX.lon }, BEACH, NOW)).toBe(false);
    expect(establishesArrival({ ...good, accuracyM: 50_000 }, BEACH, NOW)).toBe(false);
    expect(establishesArrival({ ...good, accuracyM: FIX_MAX_ACCURACY_M }, BEACH, NOW)).toBe(true);
    expect(establishesArrival(good, BEACH, NOW + ARRIVAL_MAX_FIX_AGE_MS)).toBe(true);
    expect(establishesArrival(good, BEACH, NOW + ARRIVAL_MAX_FIX_AGE_MS + 1)).toBe(false);
  });

  it("rejects a future-dated or timestamp-less fix, and no fix at all", () => {
    expect(establishesArrival({ ...good, at: NOW + 5 * 60_000 }, BEACH, NOW)).toBe(false);
    expect(establishesArrival({ ...good, at: NaN }, BEACH, NOW)).toBe(false);
    expect(establishesArrival(null, BEACH, NOW)).toBe(false);
    expect(establishesArrival(good, null, NOW)).toBe(false);
  });
});

describe("decideArm — one validated decision per request (LOC-04, LOC-05)", () => {
  const A: LocationPublic = { slug: "beach-a", name: "Beach A", region: "FL", lat: 26.35, lon: -80.08, timezone: "America/New_York", tier: "curated" };
  const B: LocationPublic = { slug: "beach-b", name: "Beach B", region: "FL", lat: 26.45, lon: -80.06, timezone: "America/New_York", tier: "curated" };
  const beaches = [A, B];
  const atA = { lat: 26.351, lon: -80.081, accuracyM: 15, at: NOW };
  const atB = { lat: 26.451, lon: -80.061, accuracyM: 15, at: NOW };
  const nowhere = { lat: 27.5, lon: -81.5, accuracyM: 15, at: NOW };

  it("auto: arms the beach the FRESH fix is at, not the one the card saw before the await", () => {
    // The card believed the phone was at A; the fresh fix says B.
    const d = decideArm({ mode: "auto", freshFix: atB, beaches, pageSlug: "beach-a", presence: null, now: NOW });
    expect(d).toMatchObject({ ok: true, slug: "beach-b", source: "auto", fromSpot: true });
    expect(d.ok && d.coords.lat).toBe(atB.lat);
  });

  it("auto: cancels when the fresh fix is far from every beach — no arm for the old nearby beach", () => {
    expect(decideArm({ mode: "auto", freshFix: nowhere, beaches, pageSlug: "beach-a", presence: null, now: NOW }))
      .toEqual({ ok: false, reason: "no-arrival" });
  });

  it("auto: cancels on a failed refresh instead of arming from an obsolete fix (LOC-06)", () => {
    expect(decideArm({ mode: "auto", freshFix: null, beaches, pageSlug: "beach-a", presence: null, now: NOW }))
      .toEqual({ ok: false, reason: "no-arrival" });
  });

  it("auto: cancels on a fix too imprecise to establish arrival (LOC-12)", () => {
    const fuzzy = { ...atA, accuracyM: 50_000 };
    expect(decideArm({ mode: "auto", freshFix: fuzzy, beaches, pageSlug: "beach-a", presence: null, now: NOW }).ok).toBe(false);
  });

  it("manual: targets the page's beach; coordinates only when actually there", () => {
    const here = decideArm({ mode: "manual", freshFix: atA, beaches, pageSlug: "beach-a", presence: null, now: NOW });
    expect(here).toMatchObject({ ok: true, slug: "beach-a", source: "manual", fromSpot: true });
    const away = decideArm({ mode: "manual", freshFix: atB, beaches, pageSlug: "beach-a", presence: null, now: NOW });
    expect(away).toMatchObject({ ok: true, slug: "beach-a", source: "manual", fromSpot: false });
    expect(away.ok && away.coords).toEqual({ lat: null, lon: null, accuracyM: null, fixAt: null });
  });

  it("extend: keeps the session's own beach while browsing another page (LOC-05)", () => {
    const d = decideArm({
      mode: "extend",
      freshFix: atB,
      beaches,
      pageSlug: "beach-b",
      presence: { slug: "beach-a", source: "manual" },
      now: NOW,
    });
    expect(d).toMatchObject({ ok: true, slug: "beach-a", source: "manual", fromSpot: false });
  });

  it("extend: fails cleanly with no session to extend", () => {
    expect(decideArm({ mode: "extend", freshFix: atA, beaches, pageSlug: "beach-a", presence: null, now: NOW }))
      .toEqual({ ok: false, reason: "no-session" });
  });
});

describe("shouldRetarget — auto sessions follow the phone, manual ones are sticky (LOC-02)", () => {
  it("moves an auto session to a different beach the phone has arrived at", () => {
    expect(shouldRetarget({ slug: "a", source: "auto" }, "b", true)).toBe(true);
  });
  it("never moves a manual session", () => {
    expect(shouldRetarget({ slug: "a", source: "manual" }, "b", true)).toBe(false);
  });
  it("needs an established arrival, a different beach, and a session", () => {
    expect(shouldRetarget({ slug: "a", source: "auto" }, "b", false)).toBe(false);
    expect(shouldRetarget({ slug: "a", source: "auto" }, "a", true)).toBe(false);
    expect(shouldRetarget(null, "b", true)).toBe(false);
    expect(shouldRetarget({ slug: "a", source: "auto" }, null, true)).toBe(false);
  });
});

describe("shouldRefreshPresence — position upload is independent of the expiry (LOC-02)", () => {
  it("uploads a newer fix once the throttle has passed", () => {
    expect(shouldRefreshPresence(NOW + PRESENCE_REFRESH_MS, NOW, NOW + 60_000, NOW - 60_000)).toBe(true);
  });
  it("is bounded by the throttle", () => {
    expect(shouldRefreshPresence(NOW + PRESENCE_REFRESH_MS - 1, NOW, NOW + 60_000, NOW - 60_000)).toBe(false);
  });
  it("sends nothing when the fix is not newer than the one already sent, or there is none", () => {
    expect(shouldRefreshPresence(NOW + HOUR, NOW, NOW - 60_000, NOW - 60_000)).toBe(false);
    expect(shouldRefreshPresence(NOW + HOUR, NOW, null, null)).toBe(false);
  });
  it("uploads the first fix a session ever gets", () => {
    expect(shouldRefreshPresence(NOW + HOUR, NOW, NOW + 60_000, null)).toBe(true);
  });
});

describe("resolveDelivery — monitoring is not delivery (LOC-03)", () => {
  it("is ready only with a token the server holds or the phone confirms", () => {
    expect(resolveDelivery(true, "off")).toBe("ready");
    expect(resolveDelivery(null, "on")).toBe("ready");
  });
  it("never claims ready without a token", () => {
    expect(resolveDelivery(false, null)).toBe("needs-setup");
    expect(resolveDelivery(false, "on")).toBe("needs-setup"); // server is the authority on the token
    expect(resolveDelivery(null, "off")).toBe("needs-setup");
    expect(resolveDelivery(null, null)).toBe("unknown");
  });
  it("a phone that blocked notifications is denied, whatever the server holds", () => {
    expect(resolveDelivery(true, "denied")).toBe("denied");
  });
});
