import { describe, it, expect } from "vitest";
import { alertStatus, canonicalAlertId, currentSrfPeriod, isAlertInEffectAt, isAlertUpcomingAt, levelForModelProb, resolveRipNow, ripAlertsNow, ripCapFor } from "@/lib/ripRisk/resolve";
import type { NwsAlert, SrfPeriod } from "@/lib/types";

// Today's real Boca case (spec fixture): SRF TODAY High / FRIDAY High, Rip
// Current Statement onset 2026-09-25T06:00Z -> ends 2026-09-26T12:00Z.
const RIP_ALERT: NwsAlert = {
  id: "urn:oid:2.49.0.1.840.0.boca-rip-1",
  event: "Rip Current Statement",
  severity: "Moderate",
  status: "Actual",
  messageType: "Alert",
  onset: "2026-09-25T06:00:00Z",
  ends: "2026-09-26T12:00:00Z",
};
const SRF_PERIODS: SrfPeriod[] = [
  { label: "TODAY", level: "high", start: "2026-09-24T14:00:00Z", end: "2026-09-24T22:00:00Z" },
  { label: "TONIGHT", level: "high", start: "2026-09-24T22:00:00Z", end: "2026-09-25T10:00:00Z" },
  { label: "FRIDAY", level: "high", start: "2026-09-25T10:00:00Z", end: "2026-09-25T22:00:00Z" },
];

describe("alertStatus", () => {
  it("is scheduled before onset, inEffect during, ended after", () => {
    const onset = Date.parse("2026-09-25T06:00:00Z");
    const end = Date.parse("2026-09-26T12:00:00Z");
    expect(alertStatus(onset, end, Date.parse("2026-09-24T18:00:00Z"))).toBe("scheduled");
    expect(alertStatus(onset, end, Date.parse("2026-09-25T07:00:00Z"))).toBe("inEffect");
    expect(alertStatus(onset, end, Date.parse("2026-09-26T13:00:00Z"))).toBe("ended");
  });

  it("resolves an hour-boundary onset at :30 past the hour correctly", () => {
    const onset = Date.parse("2026-09-25T06:30:00Z");
    const end = Date.parse("2026-09-26T00:00:00Z");
    expect(alertStatus(onset, end, Date.parse("2026-09-25T06:29:00Z"))).toBe("scheduled");
    expect(alertStatus(onset, end, Date.parse("2026-09-25T06:30:00Z"))).toBe("inEffect");
    expect(alertStatus(onset, end, Date.parse("2026-09-25T06:31:00Z"))).toBe("inEffect");
  });
});

describe("currentSrfPeriod", () => {
  it("picks the period whose window contains now", () => {
    const p = currentSrfPeriod(SRF_PERIODS, Date.parse("2026-09-24T18:00:00Z"));
    expect(p?.periodLabel).toBe("TODAY");
    const p2 = currentSrfPeriod(SRF_PERIODS, Date.parse("2026-09-25T12:00:00Z"));
    expect(p2?.periodLabel).toBe("FRIDAY");
  });
});

describe("resolveRipNow — Boca 2026-09-24/25 fixture", () => {
  it("before onset: alert is NOT in effect, resolves via the SRF TODAY High period, cap 85 (not from the alert)", () => {
    const now = Date.parse("2026-09-24T18:00:00Z");
    const result = resolveRipNow({ alerts: [RIP_ALERT], srfPeriods: SRF_PERIODS, now });
    expect(result.source).toBe("forecast");
    expect(result.level).toBe("high");
    expect(result.alert).toBeNull();
    expect(result.upcomingAlert?.status).toBe("scheduled");
    expect(result.period?.periodLabel).toBe("TODAY");
    expect(ripCapFor(result)).toBe(85);
  });

  it("after onset: alert is in effect, resolves via the alert", () => {
    const now = Date.parse("2026-09-25T07:00:00Z");
    const result = resolveRipNow({ alerts: [RIP_ALERT], srfPeriods: SRF_PERIODS, now });
    expect(result.source).toBe("alert");
    expect(result.alert?.status).toBe("inEffect");
    expect(result.upcomingAlert).toBeNull();
    expect(ripCapFor(result)).toBe(85);
  });

  it("after the alert's end: alert status is ended, no active alert, falls back to SRF period", () => {
    const now = Date.parse("2026-09-26T13:00:00Z");
    const alertsAtNow = ripAlertsNow([RIP_ALERT], now);
    expect(alertsAtNow[0].status).toBe("ended");
    const result = resolveRipNow({ alerts: [RIP_ALERT], srfPeriods: [], now });
    expect(result.alert).toBeNull();
  });

  it("a moderate-only SRF period (no alert) caps at 92", () => {
    const periods: SrfPeriod[] = [
      { label: "TODAY", level: "moderate", start: "2026-09-24T14:00:00Z", end: "2026-09-24T22:00:00Z" },
    ];
    const result = resolveRipNow({ alerts: [], srfPeriods: periods, now: Date.parse("2026-09-24T18:00:00Z") });
    expect(result.source).toBe("forecast");
    expect(ripCapFor(result)).toBe(92);
  });

  it("a scheduled (future) alert alone with no SRF/estimate: no cap at all", () => {
    const result = resolveRipNow({
      alerts: [RIP_ALERT],
      srfPeriods: [],
      now: Date.parse("2026-09-24T18:00:00Z"),
    });
    expect(result.source).toBe("unknown");
    expect(ripCapFor(result)).toBeNull();
    expect(result.upcomingAlert?.id).toBe(RIP_ALERT.id);
  });

  it("no alert, no model, no SRF: unknown, no cap (the experimental physics estimate was removed from the hierarchy)", () => {
    const result = resolveRipNow({
      alerts: [],
      srfPeriods: [],
      now: Date.parse("2026-09-24T18:00:00Z"),
    });
    expect(result.source).toBe("unknown");
    expect(result.level).toBe("unknown");
    expect(ripCapFor(result)).toBeNull();
  });
});

describe("ripAlertsNow — update/cancel by id", () => {
  it("a later poll's updated alert (same id, new interval) replaces the prior read", () => {
    const now = Date.parse("2026-09-25T07:00:00Z");
    const updated: NwsAlert = { ...RIP_ALERT, messageType: "Update", ends: "2026-09-27T00:00:00Z" };
    // Per-fetch parsing: api.weather.gov's /alerts/active already reflects the
    // latest state, so passing only the updated alert is the merge.
    const resolved = ripAlertsNow([updated], now);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].end).toBe("2026-09-27T00:00:00Z");
  });

  it("a cancelled alert is simply absent from the next /alerts/active fetch", () => {
    const now = Date.parse("2026-09-25T07:00:00Z");
    const resolved = ripAlertsNow([], now);
    expect(resolved).toHaveLength(0);
  });
});

describe("isRipAlertEvent boundary via ripAlertsNow", () => {
  it("a High Surf Advisory never becomes a rip officialAlert", () => {
    const surf: NwsAlert = {
      id: "x1",
      event: "High Surf Advisory",
      severity: "Moderate",
      onset: "2026-09-24T00:00:00Z",
      ends: "2026-09-25T00:00:00Z",
    };
    expect(ripAlertsNow([surf], Date.parse("2026-09-24T12:00:00Z"))).toHaveLength(0);
  });

  it("a Beach Hazards Statement only counts when it mentions rip currents", () => {
    const withRip: NwsAlert = {
      id: "x2",
      event: "Beach Hazards Statement",
      severity: "Moderate",
      headline: "Beach Hazards Statement for dangerous rip currents",
      onset: "2026-09-24T00:00:00Z",
      ends: "2026-09-25T00:00:00Z",
    };
    const withoutRip: NwsAlert = {
      id: "x3",
      event: "Beach Hazards Statement",
      severity: "Moderate",
      headline: "Beach Hazards Statement for dangerous surf",
      onset: "2026-09-24T00:00:00Z",
      ends: "2026-09-25T00:00:00Z",
    };
    expect(ripAlertsNow([withRip], Date.parse("2026-09-24T12:00:00Z"))).toHaveLength(1);
    expect(ripAlertsNow([withoutRip], Date.parse("2026-09-24T12:00:00Z"))).toHaveLength(0);
  });
});

describe("resolveRipNow — NOAA model source (2026-09-24 NWPS integration)", () => {
  const MODEL_RUN = "2026-09-24T00:00:00Z";

  it("a fresh model value outranks the SRF forecast period", () => {
    const periods: SrfPeriod[] = [
      { label: "TODAY", level: "moderate", start: "2026-09-24T14:00:00Z", end: "2026-09-24T22:00:00Z" },
    ];
    const now = Date.parse("2026-09-24T18:00:00Z");
    const result = resolveRipNow({
      alerts: [],
      srfPeriods: periods,
      model: { prob: 65, level: "high", run: MODEL_RUN },
      now,
    });
    expect(result.source).toBe("model");
    expect(result.level).toBe("high");
    expect(ripCapFor(result)).toBe(85);
  });

  it("an alert actually in effect still outranks the model", () => {
    const now = Date.parse("2026-09-25T07:00:00Z");
    const result = resolveRipNow({
      alerts: [RIP_ALERT],
      srfPeriods: SRF_PERIODS,
      model: { prob: 5, level: "low", run: "2026-09-25T00:00:00Z" },
      now,
    });
    expect(result.source).toBe("alert");
  });

  it("a stale model run (>36h old) is ignored, falling back to the SRF period", () => {
    const now = Date.parse("2026-09-24T18:00:00Z");
    const periods: SrfPeriod[] = [
      { label: "TODAY", level: "moderate", start: "2026-09-24T14:00:00Z", end: "2026-09-24T22:00:00Z" },
    ];
    const staleRun = "2026-09-22T00:00:00Z"; // ~66h before `now`
    const result = resolveRipNow({
      alerts: [],
      srfPeriods: periods,
      model: { prob: 80, level: "high", run: staleRun },
      now,
    });
    expect(result.source).toBe("forecast");
    expect(result.model).toBeNull();
  });

  it("Boca fixture: fresh model raw 3% + SRF High -> resolves Moderate (one step below SRF), cap 92, watch=true, raw % preserved on .model", () => {
    // Real numbers from the 2026-09-24 00z MFL run at Boca's mapped point
    // (279.9340/26.3616): ~2-3% probability around this hour. Per the
    // disagreement rule: a FRESH model (run age <= 18h here: run and now are
    // both 2026-09-24) never pulls the result past one band below a
    // disagreeing SRF word — so Low-band model + High SRF -> Moderate, not
    // Low. The raw 2.6% is still exposed via result.model for the UI to show
    // prominently alongside the "NWS forecast High" disagreement.
    const now = Date.parse("2026-09-24T18:00:00Z"); // RIP_ALERT onset is 2026-09-25T06:00Z
    const result = resolveRipNow({
      alerts: [RIP_ALERT],
      srfPeriods: SRF_PERIODS, // TODAY = high
      model: { prob: 2.6, level: "low", run: MODEL_RUN },
      now,
    });
    expect(result.source).toBe("model");
    expect(result.level).toBe("moderate");
    expect(result.model?.prob).toBe(2.6);
    expect(result.watch).toBe(true); // resolved (moderate) still reads below the SRF word (high)
    expect(result.upcomingAlert?.id).toBe(RIP_ALERT.id);
    expect(ripCapFor(result)).toBe(92);
  });

  it("Boca fixture: later the same evening, the model itself has risen to High", () => {
    const now = Date.parse("2026-09-24T20:00:00Z");
    const result = resolveRipNow({
      alerts: [],
      srfPeriods: SRF_PERIODS,
      model: { prob: 55, level: "high", run: MODEL_RUN },
      now,
    });
    expect(result.source).toBe("model");
    expect(result.level).toBe("high");
    expect(result.watch).toBe(false); // model is no longer BELOW the SRF period
    expect(ripCapFor(result)).toBe(85);
  });

  it("watch is false when the model already agrees with (or exceeds) the SRF period", () => {
    const now = Date.parse("2026-09-24T18:00:00Z");
    const result = resolveRipNow({
      alerts: [RIP_ALERT],
      srfPeriods: SRF_PERIODS, // TODAY = high
      model: { prob: 60, level: "high", run: MODEL_RUN },
      now,
    });
    expect(result.watch).toBe(false);
  });
});

describe("resolveRipNow — alert in effect is ALWAYS High (item 2)", () => {
  it("an alert in effect resolves High even when the SRF period is only Moderate", () => {
    const alert = { ...RIP_ALERT, onset: "2026-09-24T10:00:00Z", ends: "2026-09-24T22:00:00Z" };
    const periods: SrfPeriod[] = [
      { label: "TODAY", level: "moderate", start: "2026-09-24T00:00:00Z", end: "2026-09-25T00:00:00Z" },
    ];
    const now = Date.parse("2026-09-24T15:00:00Z");
    const result = resolveRipNow({ alerts: [alert], srfPeriods: periods, now });
    expect(result.source).toBe("alert");
    expect(result.level).toBe("high");
    expect(ripCapFor(result)).toBe(85);
  });

  it("an alert in effect resolves High even with a disagreeing Low model reading", () => {
    const alert = { ...RIP_ALERT, onset: "2026-09-24T10:00:00Z", ends: "2026-09-24T22:00:00Z" };
    const now = Date.parse("2026-09-24T15:00:00Z");
    const result = resolveRipNow({
      alerts: [alert],
      srfPeriods: [],
      model: { prob: 3, level: "low", run: "2026-09-24T12:00:00Z" },
      now,
    });
    expect(result.source).toBe("alert");
    expect(result.level).toBe("high");
  });
});

describe("resolveRipNow — aging model (18-36h) may only upgrade the SRF word, never downgrade (item 8)", () => {
  const AGING_RUN = "2026-09-23T00:00:00Z"; // 24h before `now` below -> aging tier

  it("aging model reads Low under an SRF High -> stays High (no downgrade)", () => {
    const now = Date.parse("2026-09-24T00:00:00Z");
    const periods: SrfPeriod[] = [
      { label: "TODAY", level: "high", start: "2026-09-23T23:00:00Z", end: "2026-09-24T10:00:00Z" },
    ];
    const result = resolveRipNow({
      alerts: [],
      srfPeriods: periods,
      model: { prob: 3, level: "low", run: AGING_RUN },
      now,
    });
    expect(result.level).toBe("high");
  });

  it("aging model reads High under an SRF Low -> upgrades to High", () => {
    const now = Date.parse("2026-09-24T00:00:00Z");
    const periods: SrfPeriod[] = [
      { label: "TODAY", level: "low", start: "2026-09-23T23:00:00Z", end: "2026-09-24T10:00:00Z" },
    ];
    const result = resolveRipNow({
      alerts: [],
      srfPeriods: periods,
      model: { prob: 70, level: "high", run: AGING_RUN },
      now,
    });
    expect(result.level).toBe("high");
  });
});

describe("resolveRipNow — hourEndMs overlap marking for an hour bucket (item 11)", () => {
  it("an alert starting mid-bucket still marks the whole hour as in-effect (High)", () => {
    const alert = { ...RIP_ALERT, onset: "2026-09-24T14:30:00Z", ends: "2026-09-24T20:00:00Z" };
    const hourStart = Date.parse("2026-09-24T14:00:00Z");
    const result = resolveRipNow({
      alerts: [alert],
      srfPeriods: [],
      now: hourStart,
      hourEndMs: hourStart + 3_600_000,
    });
    expect(result.source).toBe("alert");
    expect(result.level).toBe("high");
  });

  it("without hourEndMs, the same point-in-time bucket start does NOT see the mid-bucket alert (point check only)", () => {
    const alert = { ...RIP_ALERT, onset: "2026-09-24T14:30:00Z", ends: "2026-09-24T20:00:00Z" };
    const hourStart = Date.parse("2026-09-24T14:00:00Z");
    const result = resolveRipNow({ alerts: [alert], srfPeriods: [], now: hourStart });
    expect(result.source).not.toBe("alert");
  });
});

describe("levelForModelProb — boundary tests (item: 19.9/20/49.9/50)", () => {
  it("bands exactly at the documented cutoffs", () => {
    expect(levelForModelProb(19.9)).toBe("low");
    expect(levelForModelProb(20)).toBe("moderate");
    expect(levelForModelProb(49.9)).toBe("moderate");
    expect(levelForModelProb(50)).toBe("high");
  });
});

describe("canonicalAlertId — CAP references chain (item 5: an update of the same incident doesn't re-push)", () => {
  it("with no references, falls back to the alert's own id", () => {
    expect(canonicalAlertId({ id: "urn:oid:new-1", event: "Rip Current Statement", severity: "Moderate" })).toBe(
      "urn:oid:new-1",
    );
  });

  it("with a references URL chain (api.weather.gov style), returns the ORIGINAL identifier, not the update's own id", () => {
    const updated = {
      id: "urn:oid:update-2", // NWS gave the update a NEW id
      event: "Rip Current Statement",
      severity: "Moderate",
      references: "https://api.weather.gov/alerts/urn:oid:original-1",
    };
    expect(canonicalAlertId(updated)).toBe("urn:oid:original-1");
  });

  it("with a raw CAP sender,identifier,sent references triple, extracts the identifier field", () => {
    const updated = {
      id: "urn:oid:update-3",
      event: "Rip Current Statement",
      severity: "Moderate",
      references: "w-nws.webmaster@noaa.gov,urn:oid:original-1,2026-09-24T00:00:00-04:00",
    };
    expect(canonicalAlertId(updated)).toBe("urn:oid:original-1");
  });

  it("resolveRipNow keeps the SAME resolved alert id across an update (so the push dedup key stays stable)", () => {
    const original: NwsAlert = {
      id: "urn:oid:original-1",
      event: "Rip Current Statement",
      severity: "Moderate",
      onset: "2026-09-24T06:00:00Z",
      ends: "2026-09-25T06:00:00Z",
    };
    const update: NwsAlert = {
      ...original,
      id: "urn:oid:update-2",
      references: "https://api.weather.gov/alerts/urn:oid:original-1",
      messageType: "Update",
    };
    const now = Date.parse("2026-09-24T12:00:00Z");
    expect(resolveRipNow({ alerts: [original], srfPeriods: [], now }).alert?.id).toBe("urn:oid:original-1");
    expect(resolveRipNow({ alerts: [update], srfPeriods: [], now }).alert?.id).toBe("urn:oid:original-1");
  });
});

describe("isAlertInEffectAt / isAlertUpcomingAt — the shared generic-alert gate (round 2 item 1)", () => {
  const SEVERE: NwsAlert = {
    id: "x",
    event: "Tornado Warning",
    severity: "Extreme",
    onset: "2026-09-24T10:00:00Z",
    ends: "2026-09-24T14:00:00Z",
  };

  it("in effect strictly between onset and end", () => {
    expect(isAlertInEffectAt(SEVERE, Date.parse("2026-09-24T09:59:00Z"))).toBe(false);
    expect(isAlertInEffectAt(SEVERE, Date.parse("2026-09-24T12:00:00Z"))).toBe(true);
    expect(isAlertInEffectAt(SEVERE, Date.parse("2026-09-24T14:00:00Z"))).toBe(false);
  });

  it("upcoming only strictly before onset", () => {
    expect(isAlertUpcomingAt(SEVERE, Date.parse("2026-09-24T09:59:00Z"))).toBe(true);
    expect(isAlertUpcomingAt(SEVERE, Date.parse("2026-09-24T12:00:00Z"))).toBe(false);
    expect(isAlertUpcomingAt(SEVERE, Date.parse("2026-09-24T14:01:00Z"))).toBe(false);
  });

  it("an alert with no parseable onset/end is neither in effect nor upcoming (honest unknown, never 'always active')", () => {
    const noInterval: NwsAlert = { id: "y", event: "Tornado Warning", severity: "Extreme" };
    expect(isAlertInEffectAt(noInterval, Date.now())).toBe(false);
    expect(isAlertUpcomingAt(noInterval, Date.now())).toBe(false);
  });
});
