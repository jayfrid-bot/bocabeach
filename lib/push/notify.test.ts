import { describe, it, expect } from "vitest";
import {
  decideNotifications,
  summarizeForPush,
  MORNING_HOUR,
  type Notifiable,
} from "@/lib/push/notify";
import type { ConditionsResponse } from "@/lib/types";

function sub(over: Partial<Notifiable> = {}): Notifiable {
  return { prefs: { morning: true, safety: true }, ...over };
}

const SUMMARY = {
  slug: "boca-raton",
  name: "Boca Raton",
  score: 85,
  verdict: "Excellent",
  bestWindow: "10 AM–2 PM",
  safetyKey: undefined as string | undefined,
  safetyText: undefined as string | undefined,
};

describe("decideNotifications", () => {
  it("sends the morning summary once at the morning hour", () => {
    const r = decideNotifications(sub(), SUMMARY, MORNING_HOUR, "2026-06-15");
    const m = r.sends.find((s) => s.tag === "morning");
    expect(m).toBeTruthy();
    expect(m!.body).toContain("Best window 10 AM–2 PM");
    expect(m!.url).toBe("/boca-raton");
    expect(r.nextSent.morningDate).toBe("2026-06-15");
  });

  it("does not resend the morning summary the same day", () => {
    const r = decideNotifications(
      sub({ sent: { morningDate: "2026-06-15" } }),
      SUMMARY,
      MORNING_HOUR,
      "2026-06-15",
    );
    expect(r.sends.find((s) => s.tag === "morning")).toBeUndefined();
  });

  it("does not send the morning summary outside the morning hour", () => {
    const r = decideNotifications(sub(), SUMMARY, MORNING_HOUR + 4, "2026-06-15");
    expect(r.sends.find((s) => s.tag === "morning")).toBeUndefined();
  });

  it("respects the morning opt-out", () => {
    const r = decideNotifications(
      sub({ prefs: { morning: false, safety: true } }),
      SUMMARY,
      MORNING_HOUR,
      "2026-06-15",
    );
    expect(r.sends.find((s) => s.tag === "morning")).toBeUndefined();
  });

  it("sends a safety alert on a new hazard and dedups while it persists", () => {
    const danger = { ...SUMMARY, safetyKey: "lightning", safetyText: "Lightning within 5 miles." };
    const first = decideNotifications(sub(), danger, 14, "2026-06-15");
    expect(first.sends.find((s) => s.tag === "safety")).toBeTruthy();
    expect(first.nextSent.safetyKey).toBe("lightning");
    const again = decideNotifications(
      sub({ sent: { safetyKey: "lightning" } }),
      danger,
      15,
      "2026-06-15",
    );
    expect(again.sends.find((s) => s.tag === "safety")).toBeUndefined();
  });

  it("re-alerts when the hazard changes, and clears state when safe", () => {
    const hazard = { ...SUMMARY, safetyKey: "hazard", safetyText: "Beach Hazards Statement." };
    const changed = decideNotifications(sub({ sent: { safetyKey: "lightning" } }), hazard, 14, "2026-06-15");
    expect(changed.sends.find((s) => s.tag === "safety")).toBeTruthy();
    const clear = decideNotifications(sub({ sent: { safetyKey: "hazard" } }), SUMMARY, 14, "2026-06-15");
    expect(clear.sends.find((s) => s.tag === "safety")).toBeUndefined();
    expect(clear.nextSent.safetyKey).toBeUndefined();
  });

  it("respects the safety opt-out", () => {
    const danger = { ...SUMMARY, safetyKey: "lightning", safetyText: "x" };
    const r = decideNotifications(
      sub({ prefs: { morning: true, safety: false } }),
      danger,
      14,
      "2026-06-15",
    );
    expect(r.sends.find((s) => s.tag === "safety")).toBeUndefined();
  });
});

describe("summarizeForPush", () => {
  function res(over: Record<string, unknown>): ConditionsResponse {
    return {
      score: { score: 85 },
      multiDayWindows: [
        {
          date: "2026-06-15",
          dow: "Today",
          best: { startIso: "2026-06-15T14:00:00Z", endIso: "2026-06-15T18:00:00Z", score: 85 },
          peakScore: 85,
          emoji: "☀️",
        },
      ],
      snapshot: {
        lightning: { status: "ok", data: over.lightning ?? null },
        nws: { data: { alerts: over.alerts ?? [], ripCurrentRisk: over.rip ?? "low" } },
        cityOfficial: { data: { flags: over.flags ?? [], noSwimAdvisory: over.noSwim } },
        waterQuality: { data: { advisory: over.waterAdvisory ?? false } },
      },
    } as unknown as ConditionsResponse;
  }
  const loc = { slug: "boca-raton", name: "Boca Raton", tz: "America/New_York" };

  it("extracts score, verdict, and today's best window", () => {
    const s = summarizeForPush(res({}), loc);
    expect(s.score).toBe(85);
    expect(s.verdict).toBeTruthy();
    expect(s.bestWindow).toMatch(/–/); // a time range
    expect(s.safetyKey).toBeUndefined();
  });

  it("prioritizes lightning over a concurrent beach-hazards statement", () => {
    const s = summarizeForPush(
      res({
        lightning: { nearestMi: 3, lastMinutesAgo: 5 },
        alerts: [{ event: "Beach Hazards Statement", severity: "Moderate" }],
      }),
      loc,
    );
    expect(s.safetyKey).toBe("lightning");
  });

  it("falls back to a beach-hazards statement when no higher hazard is active", () => {
    const s = summarizeForPush(
      res({ alerts: [{ event: "Beach Hazards Statement", severity: "Moderate" }] }),
      loc,
    );
    expect(s.safetyKey).toBe("hazard");
  });

  it("flags a red lifeguard flag", () => {
    const s = summarizeForPush(res({ flags: ["red"] }), loc);
    expect(s.safetyKey).toBe("flag:red");
  });

  it("alerts on moderate rip current, matching the in-app banner", () => {
    const s = summarizeForPush(res({ rip: "moderate" }), loc);
    expect(s.safetyKey).toBe("rip-moderate");
  });
});
