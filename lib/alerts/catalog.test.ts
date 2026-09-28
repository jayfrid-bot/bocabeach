// The APNs / FCM collapse id (#8): different hazards must never share one (a
// rain update must not replace a lightning warning), the SAME hazard at the
// SAME beach must (a repeat update replaces its predecessor, and an
// escalation replaces the plain notice), and the same hazard at two
// different beaches must not collide either.

import { describe, it, expect } from "vitest";
import { buildAlert, CATALOG } from "@/lib/alerts/catalog";
import { ALERT_KEYS, defaultPrefs } from "@/lib/db/types";

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

  it("scopes the at-beach DEDUP key to the beach, and leaves the home tier alone (LOC-08)", () => {
    const here = buildAlert({ key: "flag", flag: "double-red" }, BOCA);
    const there = buildAlert({ key: "flag", flag: "double-red" }, COCOA);
    expect(here.dedupKey).toBe("flag:double-red@boca-raton");
    expect(there.dedupKey).toBe("flag:double-red@cocoa-beach");
    const esc = buildAlert({ key: "lightning", nearestMi: 1, escalated: true }, BOCA);
    expect(esc.dedupKey).toBe("lightning:2mi@boca-raton");
    expect(esc.supersedes).toEqual(["lightning@boca-raton"]);
    const excellent = buildAlert({ key: "score-excellent", score: 95, dedupKey: "score-excellent:2026-09-02" }, BOCA);
    expect(excellent.dedupKey).toBe("score-excellent:2026-09-02");
  });

  it("still produces a usable tag when no slug is given (the home tier never needs one)", () => {
    const excellent = buildAlert(
      { key: "score-excellent", score: 95, dedupKey: "score-excellent:2026-09-02" },
      { beach: "Boca Raton" },
    );
    expect(excellent.tag).toBe("excellent");
  });
});

describe("buildAlert — repeatMs (item 5: rip pushes once per CAP id, not every DEFAULT_REPEAT_MS)", () => {
  it("a rip finding tied to a real CAP alert id gets an effectively infinite repeatMs — it fires once for that id", () => {
    const d = buildAlert({ key: "rip", level: "high", alertId: "urn:oid:abc-123" }, BOCA);
    expect(d.repeatMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(d.dedupKey).toBe("rip:urn:oid:abc-123@boca-raton");
  });

  it("a rip finding with no alert id (back-compat, no real CAP alert) keeps the normal repeat window", () => {
    const d = buildAlert({ key: "rip", level: "high" }, BOCA);
    expect(d.repeatMs).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("other hazards are unaffected — still the normal DEFAULT_REPEAT_MS window", () => {
    const d = buildAlert({ key: "flag", flag: "red" }, BOCA);
    expect(d.repeatMs).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });
});

describe("buildAlert — coming-up (SKY_EVENTS_PLAN.md §10)", () => {
  it("is opt-in: the only ALERT_KEY defaultPrefs() starts off", () => {
    const prefs = defaultPrefs();
    for (const key of ALERT_KEYS) {
      if (key === "coming-up") expect(prefs[key]).toBe(false);
      else expect(prefs[key]).toBe(true);
    }
  });

  it("uses its own stable collapse tag — never Excellent's, even though both are 'home' tier", () => {
    const excellent = buildAlert({ key: "score-excellent", score: 95, dedupKey: "score-excellent:2027-03-08" }, BOCA);
    const comingUp = buildAlert(
      { key: "coming-up", eventType: "launch", eventKey: "launch:uuid-1", name: "SpaceX", whenLabel: "9:15 PM Wed Oct 8" },
      BOCA,
    );
    expect(comingUp.tag).toBe("coming-up");
    expect(comingUp.tag).not.toBe(excellent.tag);
  });

  it("dedupKey is exactly the event's own §10 key, unscoped by beach (the 'home' tier, and per-device alert_log is enough)", () => {
    const d = buildAlert(
      { key: "coming-up", eventType: "tide", eventKey: "tide:8722670:2027-03-08T18:00:00Z", whenLabel: "Mon Mar 8, 2:00 PM" },
      BOCA,
    );
    expect(d.dedupKey).toBe("tide:8722670:2027-03-08T18:00:00Z");
  });

  it("is never an alarm (⚠️ title) — coming-up is news, not a warning", () => {
    const d = buildAlert(
      { key: "coming-up", eventType: "supermoon", eventKey: "supermoon:2027-03-08T00:00:00Z", whenLabel: "Mon Mar 8", isClosestOfYear: true },
      BOCA,
    );
    expect(d.title).toBe("Boca Raton");
  });

  it("is not one of the at-beach keys — it never gates on being physically at the beach", () => {
    expect(CATALOG["coming-up"].tier).toBe("home");
  });

  it("copy: tide crossing", () => {
    const d = buildAlert(
      { key: "coming-up", eventType: "tide", eventKey: "tide:x:y", whenLabel: "Thu Oct 15, 11:42 AM" },
      BOCA,
    );
    expect(d.body).toBe(
      "High-tide flooding possible Thu Oct 15, 11:42 AM. The predicted astronomical tide reaches this station's minor flood level. Wind and weather can change the actual water level.",
    );
  });

  it("copy: eclipse, peak visible", () => {
    const d = buildAlert(
      {
        key: "coming-up",
        eventType: "eclipse",
        eventKey: "eclipse:x",
        kindLabel: "Total",
        whenLabel: "Sun Mar 8",
        peakTimeLabel: "1:58 AM",
        ratingLabel: "Good",
      },
      BOCA,
    );
    expect(d.body).toBe("Total lunar eclipse Sun Mar 8, peak 1:58 AM, visible here. Sky rating: Good.");
  });

  it("copy: eclipse, peak not visible", () => {
    const d = buildAlert(
      {
        key: "coming-up",
        eventType: "eclipse",
        eventKey: "eclipse:x",
        kindLabel: "Partial",
        whenLabel: "Sun Mar 8",
        visibleRangeLabel: "1:10-1:42 AM",
      },
      BOCA,
    );
    expect(d.body).toBe("Partial lunar eclipse Sun Mar 8 — visible here from 1:10-1:42 AM.");
  });

  it("copy: meteor shower", () => {
    const d = buildAlert(
      { key: "coming-up", eventType: "meteor", eventKey: "meteor:perseids:2027", showerName: "Perseids", whenLabel: "Wed Aug 12" },
      BOCA,
    );
    expect(d.body).toBe("Perseids peak Wed Aug 12, best after midnight.");
  });

  it("copy: supermoon, ranked #1 vs not, with and without the over-water line", () => {
    const rank1 = buildAlert(
      { key: "coming-up", eventType: "supermoon", eventKey: "supermoon:x", whenLabel: "Fri Oct 3", overWaterLine: "rises over the water at 7:12 PM", isClosestOfYear: true },
      BOCA,
    );
    expect(rank1.body).toBe("Supermoon Fri Oct 3, rises over the water at 7:12 PM — the closest full moon of the year.");

    const notRank1 = buildAlert(
      { key: "coming-up", eventType: "supermoon", eventKey: "supermoon:x", whenLabel: "Fri Oct 3", overWaterLine: "rises over the water at 7:12 PM", isClosestOfYear: false },
      BOCA,
    );
    expect(notRank1.body).toBe("Supermoon Fri Oct 3, rises over the water at 7:12 PM.");

    const noOverWater = buildAlert(
      { key: "coming-up", eventType: "supermoon", eventKey: "supermoon:x", whenLabel: "Fri Oct 3", isClosestOfYear: false },
      BOCA,
    );
    expect(noOverWater.body).toBe("Supermoon Fri Oct 3.");
  });

  it("copy: launch, 'targeting' wording", () => {
    const d = buildAlert(
      { key: "coming-up", eventType: "launch", eventKey: "launch:uuid-1", name: "SpaceX Falcon 9", whenLabel: "9:15 PM Wed Oct 8" },
      BOCA,
    );
    expect(d.body).toBe("SpaceX Falcon 9 is targeting a 9:15 PM Wed Oct 8 launch. Status: Go.");
  });
});
