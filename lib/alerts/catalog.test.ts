// The APNs / FCM collapse id (#8): different hazards must never share one (a
// rain update must not replace a lightning warning), the SAME hazard at the
// SAME beach must (a repeat update replaces its predecessor, and an
// escalation replaces the plain notice), and the same hazard at two
// different beaches must not collide either.

import { describe, it, expect } from "vitest";
import { buildAlert } from "@/lib/alerts/catalog";

const BOCA = { beach: "Boca Raton", slug: "boca-raton" };
const COCOA = { beach: "Cocoa Beach", slug: "cocoa-beach" };

describe("buildAlert — collapse id (tag)", () => {
  it("gives two different hazards at the same beach different collapse ids", () => {
    const lightning = buildAlert({ key: "lightning", nearestMi: 3, escalated: false }, BOCA);
    const rain = buildAlert({ key: "rain-soon", etaMinutes: 10 }, BOCA);
    expect(lightning.tag).not.toBe(rain.tag);
  });

  it("gives a repeated update of the SAME hazard at the SAME beach the SAME collapse id", () => {
    const first = buildAlert({ key: "rip", level: "moderate" }, BOCA);
    const second = buildAlert({ key: "rip", level: "high" }, BOCA); // an upgrade, still "rip"
    expect(first.tag).toBe(second.tag);
    expect(first.tag).toBe("safety:rip:boca-raton");
  });

  it("lets a lightning escalation replace the earlier lightning notice", () => {
    const plain = buildAlert({ key: "lightning", nearestMi: 3, escalated: false }, BOCA);
    const escalated = buildAlert({ key: "lightning", nearestMi: 1.4, escalated: true }, BOCA);
    expect(plain.tag).toBe(escalated.tag);
    expect(plain.tag).toBe("safety:lightning:boca-raton");
  });

  it("keeps the same hazard at two different beaches from colliding", () => {
    const here = buildAlert({ key: "lightning", nearestMi: 3, escalated: false }, BOCA);
    const there = buildAlert({ key: "lightning", nearestMi: 3, escalated: false }, COCOA);
    expect(here.tag).not.toBe(there.tag);
  });

  it("names the hazard and the beach in the tag", () => {
    const wind = buildAlert({ key: "wind-gust", gustMph: 30 }, BOCA);
    expect(wind.tag).toBe("safety:wind-gust:boca-raton");
  });

  it("keeps a severe event's tag stable across different event names — same hazard slot", () => {
    const tornado = buildAlert({ key: "severe", event: "Tornado Warning" }, BOCA);
    const flood = buildAlert({ key: "severe", event: "Flash Flood Warning" }, BOCA);
    // Different DEDUP keys (an unrelated severe event must still get through),
    // but the same collapse id — the newer severe warning replaces the display
    // of the older one exactly like Apple's store-and-forward intends.
    expect(tornado.dedupKey).not.toBe(flood.dedupKey);
    expect(tornado.tag).toBe(flood.tag);
    expect(tornado.tag).toBe("safety:severe:boca-raton");
  });

  it("keeps the morning digest and Excellent alert on their own stable ids, not hazard-specific", () => {
    const excellent = buildAlert({ key: "score-excellent", score: 95, dedupKey: "score-excellent:2026-09-02" }, BOCA);
    expect(excellent.tag).toBe("excellent");
  });

  it("still produces a usable tag when no slug is given (the home tier never needs one)", () => {
    const excellent = buildAlert(
      { key: "score-excellent", score: 95, dedupKey: "score-excellent:2026-09-02" },
      { beach: "Boca Raton" },
    );
    expect(excellent.tag).toBe("excellent");
  });
});
