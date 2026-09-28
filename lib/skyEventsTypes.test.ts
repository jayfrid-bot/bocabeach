import { describe, expect, it } from "vitest";
import {
  SKY_ALERT_EVENT_TYPES,
  SKY_EVENT_TYPES,
  type SkyAlertEventType,
  type SkyEvent,
  type SkyEventType,
} from "@/lib/skyEventsTypes";

// Pure type/shape guards for the Phase 0 domain contract
// (docs/SKY_EVENTS_PLAN.md §13). This file has no I/O and no adapters to
// exercise yet — it only asserts that the hand-maintained runtime arrays
// stay in sync with their literal-union types, so a later crew adding a
// new SkyEvent kind or alert kind can't silently forget to update both.

/** Compiles only if `SkyEventType`'s members are exactly the ones switched
 *  on below — TypeScript errors on a missing `case` (via the `never`
 *  assignment) if the union gains a member this function doesn't handle,
 *  and on an extra `case` if one is removed. Never called; its existence
 *  is the check. */
function assertSkyEventTypesExhaustive(t: SkyEventType): void {
  switch (t) {
    case "tide":
    case "eclipse":
    case "moon":
    case "meteor":
    case "launch":
      return;
    default: {
      const _exhaustive: never = t;
      return _exhaustive;
    }
  }
}
void assertSkyEventTypesExhaustive;

/** Same idea for the narrower alert-side discriminant (§10). */
function assertSkyAlertEventTypesExhaustive(t: SkyAlertEventType): void {
  switch (t) {
    case "eclipse":
    case "tide":
    case "meteor":
    case "supermoon":
    case "launch":
      return;
    default: {
      const _exhaustive: never = t;
      return _exhaustive;
    }
  }
}
void assertSkyAlertEventTypesExhaustive;

describe("SKY_EVENT_TYPES", () => {
  it("has exactly the 5 card event kinds, in the order the plan lists them", () => {
    expect(SKY_EVENT_TYPES).toEqual(["tide", "eclipse", "moon", "meteor", "launch"]);
  });

  it("has no duplicates", () => {
    expect(new Set(SKY_EVENT_TYPES).size).toBe(SKY_EVENT_TYPES.length);
  });
});

describe("SKY_ALERT_EVENT_TYPES", () => {
  it("has exactly the 5 values the single coming-up AlertSubject discriminates on", () => {
    expect(SKY_ALERT_EVENT_TYPES).toEqual(["eclipse", "tide", "meteor", "supermoon", "launch"]);
  });

  it("has no duplicates", () => {
    expect(new Set(SKY_ALERT_EVENT_TYPES).size).toBe(SKY_ALERT_EVENT_TYPES.length);
  });

  it("intentionally diverges from SKY_EVENT_TYPES only on moon vs. supermoon", () => {
    // A plain (non-super) full moon is card-only and never becomes an
    // AlertSubject — only a supermoon-flagged MoonSkyEvent does (§4, §10).
    // Every other kind is shared between the card union and the alert
    // discriminant.
    const cardOnly = SKY_EVENT_TYPES.filter((k) => !(SKY_ALERT_EVENT_TYPES as readonly string[]).includes(k));
    const alertOnly = SKY_ALERT_EVENT_TYPES.filter((k) => !(SKY_EVENT_TYPES as readonly string[]).includes(k));
    expect(cardOnly).toEqual(["moon"]);
    expect(alertOnly).toEqual(["supermoon"]);
  });
});

describe("SkyEvent union (type-level only)", () => {
  it("lets a minimal, valid literal of each kind type-check", () => {
    // No assertions beyond "this compiles" — each literal below only needs
    // to satisfy its branch of the SkyEvent union. Kept in one test so a
    // future shape change surfaces here first, not deep in a Phase 1/2 PR.
    const tide: SkyEvent = {
      eventType: "tide",
      tier: "validated",
      stationId: "8722670",
      datum: "STND",
      episode: { start: "2026-10-15T15:42:00Z", end: "2026-10-15T15:42:00Z" },
      heightFt: 34.5,
      rating: null,
      source: { feedGeneratedAt: "2026-10-01T00:00:00Z", validThrough: "2026-10-31T00:00:00Z" },
    };

    const eclipse: SkyEvent = {
      eventType: "eclipse",
      kind: "total",
      peak: "2026-03-08T05:58:00Z",
      peakIsVisible: true,
      visible: { start: "2026-03-08T05:10:00Z", end: "2026-03-08T06:42:00Z" },
      rating: null,
      source: { feedGeneratedAt: "2026-03-08T00:00:00Z", validThrough: "2026-03-09T00:00:00Z" },
    };

    const moon: SkyEvent = {
      eventType: "moon",
      fullMoonInstant: "2026-10-03T23:12:00Z",
      closeness: 0.94,
      isSupermoon: true,
      supermoonRank: 1,
      viewingWindow: { start: "2026-10-03T23:12:00Z", end: "2026-10-04T06:00:00Z" },
      moonriseLocal: "2026-10-03T23:12:00Z",
      rating: null,
      source: { feedGeneratedAt: "2026-10-01T00:00:00Z", validThrough: "2026-10-04T12:00:00Z" },
    };

    const meteor: SkyEvent = {
      eventType: "meteor",
      showerId: "perseids",
      showerName: "Perseids",
      peak: "2026-08-12T09:00:00Z",
      activityWindow: { start: "2026-07-17T00:00:00Z", end: "2026-08-24T00:00:00Z" },
      bestLocalWindow: { start: "2026-08-12T04:00:00Z", end: "2026-08-12T09:30:00Z" },
      radiantRaDeg: 48,
      radiantDecDeg: 58,
      zhr: 100,
      sourceEdition: "IMO 2026",
      rating: null,
    };

    const launch: SkyEvent = {
      eventType: "launch",
      ll2Id: "7d1afb26-6f9c-429b-9ccf-29012fd1e519",
      name: "Falcon 9 | Example",
      net: "2026-10-08T22:15:00Z",
      netPrecision: "Minute",
      windowStart: "2026-10-08T22:15:00Z",
      windowEnd: "2026-10-08T23:30:00Z",
      status: "Go",
      padId: 235,
      padLocationId: 143,
      observerLightState: "twilight",
      padLightState: "twilight",
      rangeTier: "near",
      knownOrbital: true,
      whereToLook: { bearingDeg: 349, line: "bearing 349° (nearly due north)" },
      rating: null,
      source: { feedGeneratedAt: "2026-10-08T20:00:00Z", validThrough: "2026-10-08T23:30:00Z" },
    };

    expect([tide, eclipse, moon, meteor, launch].map((e) => e.eventType)).toEqual([
      "tide",
      "eclipse",
      "moon",
      "meteor",
      "launch",
    ]);
  });
});
