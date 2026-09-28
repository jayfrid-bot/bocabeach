// The "sun-color" alert's pure decision function: threshold, send-window
// edges, dedupe, "too far to trust" gate, null score/band. No I/O, no store —
// see lib/alerts/sunColor.ts's file header.

import { describe, it, expect } from "vitest";
import {
  SUN_COLOR_AMAZING_CUTOFF,
  SUN_COLOR_GREAT_CUTOFF,
  SUN_COLOR_MAX_LEAD_MS,
  SUN_COLOR_SEND_WINDOW_MS,
  sunColorCutoffFor,
  sunColorDecision,
  sunColorEventKey,
  sunColorLeadPhrase,
  sunColorSlugNeed,
  nextSunEventEstimate,
  type SunColorAlertInput,
} from "@/lib/alerts/sunColor";
import { defaultPrefs, type DeviceRecord } from "@/lib/db/types";
import type { SunEventPrediction } from "@/lib/sunAlert";

const EVENT_ISO = "2026-09-02T23:35:00Z"; // an arbitrary sunset instant

function device(over: Partial<Pick<DeviceRecord, "prefs" | "homeSlug" | "sunColor">> = {}) {
  return {
    prefs: { ...defaultPrefs(), "sun-color": true },
    homeSlug: "boca-raton",
    sunColor: { minBand: "vivid" as const, leadMin: 60 },
    ...over,
  };
}

function prediction(over: Partial<SunEventPrediction> = {}): SunEventPrediction {
  return {
    kind: "sunset",
    eventIso: EVENT_ISO,
    peakIso: EVENT_ISO,
    score: 80,
    band: "vivid",
    ...over,
  };
}

function baseInput(over: Partial<SunColorAlertInput> = {}): SunColorAlertInput {
  return {
    device: device(),
    prediction: prediction(),
    beachName: "Boca Raton",
    tz: "America/New_York",
    // Exactly at the start of the send window for a 60-min lead: event − 60min.
    nowMs: Date.parse(EVENT_ISO) - 60 * 60_000,
    ...over,
  };
}

describe("sunColorCutoffFor", () => {
  it("Great-or-better (vivid) uses the vivid band cutoff", () => {
    expect(sunColorCutoffFor("vivid")).toBe(SUN_COLOR_GREAT_CUTOFF);
    expect(SUN_COLOR_GREAT_CUTOFF).toBe(70); // lib/sunQuality.ts's BAND_CUTOFFS "vivid" entry
  });

  it("Amazing-only (epic) uses the epic band cutoff", () => {
    expect(sunColorCutoffFor("epic")).toBe(SUN_COLOR_AMAZING_CUTOFF);
    expect(SUN_COLOR_AMAZING_CUTOFF).toBe(90); // lib/sunQuality.ts's BAND_CUTOFFS "epic" entry
  });
});

describe("sunColorDecision", () => {
  it("sends inside the window when the score clears the default (Great-or-better) cutoff", () => {
    const d = sunColorDecision(baseInput());
    expect(d).not.toBeNull();
    expect(d?.title).toBe("Great sunset coming");
    expect(d?.dedupKey).toBe(sunColorEventKey("sunset", EVENT_ISO));
    expect(d?.body).toContain("Boca Raton");
    expect(d?.body).toContain("rated Great");
  });

  it("never sends when the pref is off", () => {
    expect(sunColorDecision(baseInput({ device: device({ prefs: { ...defaultPrefs(), "sun-color": false } }) }))).toBeNull();
  });

  it("never sends without a home beach", () => {
    expect(sunColorDecision(baseInput({ device: device({ homeSlug: null }) }))).toBeNull();
  });

  it("never sends with no prediction at all", () => {
    expect(sunColorDecision(baseInput({ prediction: null }))).toBeNull();
  });

  it("never sends when the score is null (honest-null forecast)", () => {
    expect(sunColorDecision(baseInput({ prediction: prediction({ score: null, band: null }) }))).toBeNull();
  });

  it("never sends below the cutoff — a merely 'good' (not 'vivid') score", () => {
    expect(sunColorDecision(baseInput({ prediction: prediction({ score: 65, band: "good" }) }))).toBeNull();
  });

  it("Amazing-only: a vivid (70-89) score does not clear the epic cutoff", () => {
    const input = baseInput({
      device: device({ sunColor: { minBand: "epic", leadMin: 60 } }),
      prediction: prediction({ score: 85, band: "vivid" }),
    });
    expect(sunColorDecision(input)).toBeNull();
  });

  it("Amazing-only: an epic (>=90) score clears it, with the Amazing title", () => {
    const input = baseInput({
      device: device({ sunColor: { minBand: "epic", leadMin: 60 } }),
      prediction: prediction({ kind: "sunrise", score: 95, band: "epic" }),
    });
    const d = sunColorDecision(input);
    expect(d?.title).toBe("Amazing sunrise coming");
  });

  it("send-window edges: just before the window never sends", () => {
    const windowStart = Date.parse(EVENT_ISO) - 60 * 60_000;
    expect(sunColorDecision(baseInput({ nowMs: windowStart - 1 }))).toBeNull();
  });

  it("send-window edges: the window's own start sends", () => {
    const windowStart = Date.parse(EVENT_ISO) - 60 * 60_000;
    expect(sunColorDecision(baseInput({ nowMs: windowStart }))).not.toBeNull();
  });

  it("send-window edges: just before the window's end still sends", () => {
    const windowStart = Date.parse(EVENT_ISO) - 60 * 60_000;
    expect(sunColorDecision(baseInput({ nowMs: windowStart + SUN_COLOR_SEND_WINDOW_MS - 1 }))).not.toBeNull();
  });

  it("send-window edges: the window's own end never sends (half-open)", () => {
    const windowStart = Date.parse(EVENT_ISO) - 60 * 60_000;
    expect(sunColorDecision(baseInput({ nowMs: windowStart + SUN_COLOR_SEND_WINDOW_MS }))).toBeNull();
  });

  it("never fires after the event has already happened", () => {
    expect(sunColorDecision(baseInput({ nowMs: Date.parse(EVENT_ISO) + 60_000 }))).toBeNull();
  });

  it("never fires right at the event instant either", () => {
    expect(sunColorDecision(baseInput({ nowMs: Date.parse(EVENT_ISO) }))).toBeNull();
  });

  it("too far out to trust: >4h ahead never sends, even sitting inside its own (hypothetical, longer-than-offered) send window", () => {
    // The settings sheet only offers leads up to 3h (never >4h ahead of the
    // window start), so this exercises the trust gate directly with a
    // longer lead than the UI offers, isolating it from the window check.
    const leadMin = 300; // 5h — beyond SUN_COLOR_MAX_LEAD_MS on its own
    const windowStart = Date.parse(EVENT_ISO) - leadMin * 60_000;
    const input = baseInput({
      device: device({ sunColor: { minBand: "vivid", leadMin } }),
      nowMs: windowStart, // inside its own send window...
    });
    expect(Date.parse(EVENT_ISO) - windowStart).toBeGreaterThan(SUN_COLOR_MAX_LEAD_MS);
    expect(sunColorDecision(input)).toBeNull(); // ...but still rejected: too far out to trust
  });

  it("exactly at the 4h trust boundary is still eligible (>, not >=, rejects)", () => {
    const input = baseInput({
      device: device({ sunColor: { minBand: "vivid", leadMin: Math.round(SUN_COLOR_MAX_LEAD_MS / 60_000) } }),
      nowMs: Date.parse(EVENT_ISO) - SUN_COLOR_MAX_LEAD_MS,
    });
    expect(sunColorDecision(input)).not.toBeNull();
  });

  it("dedupe key format: sun-color:<kind>:<eventIso date-hour>", () => {
    expect(sunColorEventKey("sunset", "2026-09-28T22:15:00Z")).toBe("sun-color:sunset:2026-09-28T22");
    expect(sunColorEventKey("sunrise", "2026-09-28T10:05:00Z")).toBe("sun-color:sunrise:2026-09-28T10");
  });

  it("the decision's own dedupKey is exactly the eventKey — the caller uses one string for both the claim and alert_log", () => {
    const d = sunColorDecision(baseInput());
    expect(d?.dedupKey).toBe(sunColorEventKey("sunset", EVENT_ISO));
  });
});

describe("sunColorLeadPhrase", () => {
  it("words every offered lead time", () => {
    expect(sunColorLeadPhrase(30)).toMatch(/half hour/);
    expect(sunColorLeadPhrase(60)).toMatch(/an hour/);
    expect(sunColorLeadPhrase(120)).toMatch(/two hours/);
    expect(sunColorLeadPhrase(180)).toMatch(/three hours/);
  });
});

// --- sunColorSlugNeed / nextSunEventEstimate --------------------------------
// A cheap, fetch-free "does this beach need conditions this tick" check.

const BOCA = { lat: 26.35, lon: -80.08, timezone: "America/New_York" };

describe("nextSunEventEstimate", () => {
  it("picks today's sunset for a beach-local midday instant", () => {
    // 2026-09-02 18:00 UTC is 2 PM America/New_York — well after sunrise,
    // well before sunset, on an ordinary (non-DST-transition) day.
    const next = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z"));
    expect(next?.kind).toBe("sunset");
    expect(next!.eventMs).toBeGreaterThan(Date.parse("2026-09-02T18:00:00Z"));
  });

  it("picks tomorrow's sunrise for a beach-local instant after sunset", () => {
    // 2026-09-03 02:00 UTC is 10 PM America/New_York the night before —
    // after sunset, well before the NEXT sunrise.
    const nowMs = Date.parse("2026-09-03T02:00:00Z");
    const next = nextSunEventEstimate(BOCA, nowMs);
    expect(next?.kind).toBe("sunrise");
    expect(next!.eventMs).toBeGreaterThan(nowMs);
  });
});

describe("sunColorSlugNeed", () => {
  it("neither due nor candidate when the pref is off", () => {
    const need = sunColorSlugNeed(BOCA, device({ prefs: { ...defaultPrefs(), "sun-color": false } }), Date.now());
    expect(need).toEqual({ due: false, candidate: false });
  });

  it("neither due nor candidate without a home beach", () => {
    const need = sunColorSlugNeed(BOCA, device({ homeSlug: null }), Date.now());
    expect(need).toEqual({ due: false, candidate: false });
  });
});
