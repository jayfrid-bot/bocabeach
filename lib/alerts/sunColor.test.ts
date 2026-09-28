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

  it("Codex review item 6c: direct push copy — 'Sunset <time> at <beach>, rated <band>. Peak color about <time>. Sunset is <lead> away.'", () => {
    const d = sunColorDecision(baseInput());
    expect(d?.body).toBe("Sunset 7:35 PM at Boca Raton, rated Great. Peak color about 7:35 PM. Sunset is about an hour away.");
    expect(d?.body).not.toMatch(/if you'?re going/i);
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
    const need = sunColorSlugNeed(BOCA, device({ prefs: { ...defaultPrefs(), "sun-color": false } }), {}, Date.now());
    expect(need).toEqual({ due: false, candidate: false, eventKey: null });
  });

  it("neither due nor candidate without a home beach", () => {
    const need = sunColorSlugNeed(BOCA, device({ homeSlug: null }), {}, Date.now());
    expect(need).toEqual({ due: false, candidate: false, eventKey: null });
  });

  it("candidate (not yet due) when the next event is a few hours out", () => {
    // ~3.5h before Boca Raton's early-September sunset (~7:35 PM ET) — well
    // under the 4h horizon, but well outside the 60-min-lead send window.
    const nowMs = Date.parse("2026-09-02T20:00:00Z"); // ~4 PM ET
    const need = sunColorSlugNeed(BOCA, device(), {}, nowMs);
    expect(need.candidate).toBe(true);
    expect(need.due).toBe(false);
    expect(need.eventKey).toMatch(/^sun-color:sunset:/);
  });

  it("due once inside the send window", () => {
    // Find the real sunset first via the estimate, then ask right at its
    // 60-min-lead window start.
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z"));
    const nowMs = probe!.eventMs - 60 * 60_000;
    const need = sunColorSlugNeed(BOCA, device(), {}, nowMs);
    expect(need.due).toBe(true);
    expect(need.candidate).toBe(true);
  });

  it("neither due nor candidate once sunColorCheckedKey already names this exact event (Codex review item 2)", () => {
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z"));
    const nowMs = probe!.eventMs - 60 * 60_000; // inside the window
    const eventKey = sunColorEventKey(probe!.kind, new Date(probe!.eventMs).toISOString());
    const need = sunColorSlugNeed(BOCA, device(), { sunColorCheckedKey: eventKey }, nowMs);
    expect(need).toEqual({ due: false, candidate: false, eventKey });
  });

  it("a DIFFERENT device's/older event's checked key does not suppress a genuinely new event", () => {
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z"));
    const nowMs = probe!.eventMs - 60 * 60_000;
    const need = sunColorSlugNeed(BOCA, device(), { sunColorCheckedKey: "sun-color:sunset:2020-01-01T00" }, nowMs);
    expect(need.due).toBe(true);
  });

  it("Requirement item 5: the estimate side tolerates a few minutes' disagreement with the real snapshot at the window edges", () => {
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z"));
    const exactWindowStart = probe!.eventMs - 60 * 60_000;
    // 3 minutes before the estimate's own window technically opens — still
    // `due` thanks to the tolerance, so a beach isn't dropped from the
    // fetch list moments before the real (slightly earlier) snapshot event
    // would have made it due.
    const need = sunColorSlugNeed(BOCA, device(), {}, exactWindowStart - 3 * 60_000);
    expect(need.due).toBe(true);
  });

  it("Requirement item 5: a candidate just past the 4h horizon (within tolerance) still counts", () => {
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T00:00:00Z"));
    // 5 minutes past the strict 4h cutoff — inside the +15min tolerance.
    const nowMs = probe!.eventMs - SUN_COLOR_MAX_LEAD_MS - 5 * 60_000;
    const need = sunColorSlugNeed(BOCA, device(), {}, nowMs);
    expect(need.candidate).toBe(true);
  });

  it("Requirement item 5 — estimate 3 min EARLIER than the real snapshot: still due right up to the true (later) window's close", () => {
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z"));
    const estMs = probe!.eventMs;
    const snapMs = estMs + 3 * 60_000; // the true snapshot event lands 3 min AFTER the estimate
    const leadMin = 60;
    const trueWindowEnd = snapMs - leadMin * 60_000 + SUN_COLOR_SEND_WINDOW_MS;
    const nowMs = trueWindowEnd - 1; // 3 min past where the NAIVE estimate-only window would already have closed
    const dev = device({ sunColor: { minBand: "vivid", leadMin } });
    expect(sunColorSlugNeed(BOCA, dev, {}, nowMs).due).toBe(true);
    // And the real decision, fed the true snapshot event, genuinely has
    // something to send at that exact instant — the tolerance bought the
    // fetch that made this possible.
    const decision = sunColorDecision(
      baseInput({ device: dev, prediction: prediction({ eventIso: new Date(snapMs).toISOString() }), nowMs }),
    );
    expect(decision).not.toBeNull();
  });

  it("Requirement item 5 — estimate 3 min LATER than the real snapshot: due catches the true (earlier) window already open", () => {
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z"));
    const estMs = probe!.eventMs;
    const snapMs = estMs - 3 * 60_000; // the true snapshot event lands 3 min BEFORE the estimate
    const leadMin = 60;
    const trueWindowStart = snapMs - leadMin * 60_000; // 3 min before the naive estimate window would open
    const dev = device({ sunColor: { minBand: "vivid", leadMin } });
    expect(sunColorSlugNeed(BOCA, dev, {}, trueWindowStart).due).toBe(true);
    const decision = sunColorDecision(
      baseInput({
        device: dev,
        prediction: prediction({ eventIso: new Date(snapMs).toISOString() }),
        nowMs: trueWindowStart,
      }),
    );
    expect(decision).not.toBeNull();
  });

  it("Requirement item 5 — a stale snapshot describing yesterday's already-passed event must not send", () => {
    const staleEventIso = "2026-09-01T23:00:00Z"; // yesterday's sunset, long past
    const input = baseInput({
      prediction: prediction({ eventIso: staleEventIso }),
      nowMs: Date.parse("2026-09-02T18:00:00Z"), // today, well after that stale event
    });
    expect(sunColorDecision(input)).toBeNull();
  });

  it("Requirement item 5 — sunrise/sunset kind mismatch: a checked key for the WRONG kind never suppresses the real event", () => {
    const sameHourIso = "2026-09-02T10:00:00Z";
    expect(sunColorEventKey("sunrise", sameHourIso)).not.toBe(sunColorEventKey("sunset", sameHourIso));

    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-09-02T18:00:00Z")); // a sunset
    expect(probe?.kind).toBe("sunset");
    const wrongKindKey = sunColorEventKey("sunrise", new Date(probe!.eventMs).toISOString());
    const need = sunColorSlugNeed(BOCA, device(), { sunColorCheckedKey: wrongKindKey }, probe!.eventMs - 60 * 60_000);
    expect(need.due).toBe(true);
  });
});

// --- Regression pins (Codex review item 6e): the window math on a DST day
// and on a sunset that lands after midnight UTC. ---------------------------

describe("sunColorDecision — DST and midnight-UTC regressions", () => {
  it("a DST spring-forward day (America/New_York, 2026-03-08): the window still opens exactly `lead` minutes before sunset", () => {
    // Boca Raton's real sunset on 2026-03-08 (EST->EDT transition day,
    // 2 AM local) is a plain evening event, unaffected by the AM
    // transition — pin it via the real computeSunTimes/nextSunEventEstimate
    // pipeline so a future change to the solar math would fail this test
    // rather than silently drifting.
    const probe = nextSunEventEstimate(BOCA, Date.parse("2026-03-08T17:00:00Z"));
    expect(probe?.kind).toBe("sunset");
    const windowStart = probe!.eventMs - 60 * 60_000;
    const input = baseInput({
      prediction: prediction({ eventIso: new Date(probe!.eventMs).toISOString() }),
      nowMs: windowStart,
    });
    expect(sunColorDecision(input)).not.toBeNull();
    expect(sunColorDecision({ ...input, nowMs: windowStart - 60_000 })).toBeNull();
  });

  it("a sunrise whose UTC instant falls after midnight UTC (crossing the UTC date line) still keys/scores correctly", () => {
    // A Pacific-timezone-style early sunrise landing after 00:00 UTC (e.g.
    // Waikiki-like longitude) — the point is the ISO date component rolling
    // over must not confuse the date-hour dedupe bucket or the window math.
    const eventIso = "2026-09-03T02:15:00Z"; // 00:15 local at UTC-10-ish, well after midnight UTC
    expect(sunColorEventKey("sunrise", eventIso)).toBe("sun-color:sunrise:2026-09-03T02");
    const windowStart = Date.parse(eventIso) - 30 * 60_000;
    const input = baseInput({
      device: device({ sunColor: { minBand: "vivid", leadMin: 30 } }),
      prediction: prediction({ kind: "sunrise", eventIso }),
      nowMs: windowStart,
    });
    expect(sunColorDecision(input)).not.toBeNull();
    // Still never fires once the event (early UTC morning) has passed.
    expect(sunColorDecision({ ...input, nowMs: Date.parse(eventIso) + 60_000 })).toBeNull();
  });
});
