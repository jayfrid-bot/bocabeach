import { describe, it, expect } from "vitest";
import { pointDiffersFromBeach, whereYouStandLine, beachModeHazardLine } from "@/lib/hazards/pointVsBeach";
import type { HazardAssessment } from "@/lib/hazards/assess";

const anchor = { kind: "point" as const, lat: 26.3, lon: -80.1, cell: "26.30,-80.10" };
const beachAnchor = { kind: "beach" as const, slug: "boca-raton" };

function lightning(over: Partial<HazardAssessment> = {}): HazardAssessment {
  return {
    kind: "lightning",
    anchor,
    active: false,
    latched: false,
    severity: "none",
    observedAtIso: null,
    expiresAtIso: null,
    reason: null,
    ...over,
  };
}

function rain(over: Partial<HazardAssessment> = {}): HazardAssessment {
  return {
    kind: "rain",
    anchor,
    active: false,
    latched: false,
    severity: "none",
    observedAtIso: null,
    expiresAtIso: null,
    reason: null,
    ...over,
  };
}

describe("pointDiffersFromBeach", () => {
  it("false when both hazards agree and no distance given", () => {
    const point = { lightning: lightning(), rain: rain() };
    const beach = { lightning: lightning({ anchor: beachAnchor }), rain: rain({ anchor: beachAnchor }) };
    expect(pointDiffersFromBeach(point, beach)).toBe(false);
  });

  it("true when the point's lightning active flag differs", () => {
    const point = { lightning: lightning({ active: true, reason: "Lightning 3.8 miles away, 6 min ago" }), rain: rain() };
    const beach = { lightning: lightning({ anchor: beachAnchor }), rain: rain({ anchor: beachAnchor }) };
    expect(pointDiffersFromBeach(point, beach)).toBe(true);
  });

  it("true when the point's rain active flag differs", () => {
    const point = { lightning: lightning(), rain: rain({ active: true, reason: "Raining right now" }) };
    const beach = { lightning: lightning({ anchor: beachAnchor }), rain: rain({ anchor: beachAnchor }) };
    expect(pointDiffersFromBeach(point, beach)).toBe(true);
  });

  it("true when both active but the lightning distance differs by >= 1 mi", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain(),
      lightningMi: 3.8,
    };
    const beach = {
      lightning: lightning({ active: true, anchor: beachAnchor, reason: "Lightning 4.9 miles away, 6 min ago" }),
      rain: rain({ anchor: beachAnchor }),
      lightningMi: 4.9,
    };
    expect(pointDiffersFromBeach(point, beach)).toBe(true);
  });

  it("false when both active and the lightning distance differs by under 1 mi", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain(),
      lightningMi: 3.8,
    };
    const beach = {
      lightning: lightning({ active: true, anchor: beachAnchor, reason: "Lightning 4.3 miles away, 6 min ago" }),
      rain: rain({ anchor: beachAnchor }),
      lightningMi: 4.3,
    };
    expect(pointDiffersFromBeach(point, beach)).toBe(false);
  });

  it("true when both rain-active but one is observed and the other only latched", () => {
    const point = {
      lightning: lightning(),
      rain: rain({ active: true, latched: false, reason: "Raining right now" }),
    };
    const beach = {
      lightning: lightning({ anchor: beachAnchor }),
      rain: rain({ active: true, latched: true, anchor: beachAnchor, reason: "Rain in the last 20 minutes" }),
    };
    expect(pointDiffersFromBeach(point, beach)).toBe(true);
  });

  it("a missing distance on either side never trips the distance rule", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning within 5 miles, 2 min ago" }),
      rain: rain(),
    };
    const beach = {
      lightning: lightning({ active: true, anchor: beachAnchor, reason: "Lightning within 5 miles, 2 min ago" }),
      rain: rain({ anchor: beachAnchor }),
    };
    expect(pointDiffersFromBeach(point, beach)).toBe(false);
  });
});

describe("whereYouStandLine", () => {
  it("formats an active lightning reason with a known distance", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain(),
    };
    expect(whereYouStandLine(point)).toBe("Where you stand: lightning 3.8 mi, 6 min ago");
  });

  it("formats an active lightning reason with no distance", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning within 5 miles, 2 min ago" }),
      rain: rain(),
    };
    expect(whereYouStandLine(point)).toBe("Where you stand: lightning nearby, 2 min ago");
  });

  it("raining now", () => {
    const point = { lightning: lightning(), rain: rain({ active: true, reason: "Raining right now" }) };
    expect(whereYouStandLine(point)).toBe("Where you stand: raining now");
  });

  it("rain in the last 20 minutes", () => {
    const point = {
      lightning: lightning(),
      rain: rain({ active: true, latched: true, reason: "Rain in the last 20 minutes" }),
    };
    expect(whereYouStandLine(point)).toBe("Where you stand: rain in the last 20 min");
  });

  it("lightning outranks rain when both are active", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain({ active: true, reason: "Raining right now" }),
    };
    expect(whereYouStandLine(point)).toBe("Where you stand: lightning 3.8 mi, 6 min ago");
  });

  it("null when nothing is active", () => {
    const point = { lightning: lightning(), rain: rain() };
    expect(whereYouStandLine(point)).toBeNull();
  });
});

describe("beachModeHazardLine", () => {
  it("null when the point doesn't differ from the beach, even if active", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain(),
    };
    const beach = {
      lightning: lightning({ active: true, anchor: beachAnchor, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain({ anchor: beachAnchor }),
    };
    expect(beachModeHazardLine(point, beach)).toBeNull();
  });

  it("null when the point differs only by being CLEARER (nothing active to report)", () => {
    const point = { lightning: lightning(), rain: rain() };
    const beach = {
      lightning: lightning({ active: true, anchor: beachAnchor, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain({ anchor: beachAnchor }),
    };
    expect(beachModeHazardLine(point, beach)).toBeNull();
  });

  it("the line when the point differs and has something active", () => {
    const point = {
      lightning: lightning({ active: true, reason: "Lightning 3.8 miles away, 6 min ago" }),
      rain: rain(),
    };
    const beach = { lightning: lightning({ anchor: beachAnchor }), rain: rain({ anchor: beachAnchor }) };
    expect(beachModeHazardLine(point, beach)).toBe("Where you stand: lightning 3.8 mi, 6 min ago");
  });
});
