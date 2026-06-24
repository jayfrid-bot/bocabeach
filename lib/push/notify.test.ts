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
  rating: "Excellent",
  verdict: "Excellent",
  pros: ["warm water", "calm surf", "clean"],
  cons: ["muggy", "cloudy"],
  bestWindow: "10 AM–2 PM",
  skipWindow: undefined as string | undefined,
  safetyKey: undefined as string | undefined,
  safetyText: undefined as string | undefined,
};

describe("decideNotifications", () => {
  it("sends the morning summary once at the morning hour", () => {
    const r = decideNotifications(sub(), SUMMARY, MORNING_HOUR, "2026-06-15");
    const m = r.sends.find((s) => s.tag === "morning");
    expect(m).toBeTruthy();
    expect(m!.title).toContain("85/100");
    expect(m!.body).toContain("☀️ Warm water, calm surf & clean");
    expect(m!.body).toContain("☁️ Muggy & cloudy");
    expect(m!.body).toContain("🕓 Best time: 10 AM–2 PM");
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
      score: {
        score: (over.score as number) ?? 85,
        rating: (over.rating as string) ?? "Excellent",
        subScores: (over.subScores as unknown[]) ?? [],
      },
      hourlyScores: (over.hourlyScores as unknown[]) ?? [],
      multiDayWindows: [
        {
          date: "2026-06-15",
          dow: "Today",
          best:
            over.best !== undefined
              ? (over.best as object | null)
              : { startIso: "2026-06-15T14:00:00Z", endIso: "2026-06-15T18:00:00Z", score: 85 },
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

  it("derives qualitative pros + cons from the sub-scores (real Boca day)", () => {
    const s = summarizeForPush(
      res({
        score: 78,
        rating: "Good",
        subScores: [
          { key: "airTemp", label: "Air temperature", score: 100, weight: 0.16 },
          { key: "sky", label: "Sky (sun & rain)", score: 36, weight: 0.16 },
          { key: "wind", label: "Wind (sea breeze)", score: 100, weight: 0.13 },
          { key: "comfort", label: "Comfort (mugginess)", score: 10, weight: 0.08 },
          { key: "waterTemp", label: "Water temperature", score: 87, weight: 0.09 },
          { key: "waves", label: "Sea state (swim calmness)", score: 100, weight: 0.08 },
          { key: "waterQuality", label: "Water quality", score: 100, weight: 0.06 },
          { key: "sargassum", label: "Seaweed (sargassum)", score: 55, weight: 0.07, display: "Moderate · ~30% covered" },
          { key: "crowds", label: "Crowds", score: 94, weight: 0.05 },
          { key: "uv", label: "UV index", score: 100, weight: 0.04 },
          { key: "sandTemp", label: "Sand temperature (barefoot)", score: 100, weight: 0.08 },
        ],
      }),
      loc,
    );
    expect(s.pros).toEqual(["warm water", "calm surf", "clean", "quiet"]);
    expect(s.cons).toEqual(["muggy", "cloudy", "moderate seaweed"]);
  });

  it("flags a localized storm dip as a skip window on an otherwise-good day", () => {
    const s = summarizeForPush(
      res({
        score: 78,
        hourlyScores: [
          { time: "2026-06-15T15:00:00Z", score: 70 }, // 11 AM ET
          { time: "2026-06-15T18:00:00Z", score: 15 }, // 2 PM ET
          { time: "2026-06-15T19:00:00Z", score: 15 }, // 3 PM ET
          { time: "2026-06-15T20:00:00Z", score: 75 }, // 4 PM ET
        ],
      }),
      loc,
    );
    expect(s.skipWindow).toBe("2–3 PM");
  });

  it("falls back to the hourly best window when the forward window is gone", () => {
    const s = summarizeForPush(
      res({
        best: null,
        hourlyScores: [
          { time: "2026-06-15T15:00:00Z", score: 50 }, // 11 AM ET
          { time: "2026-06-15T19:00:00Z", score: 78 }, // 3 PM ET
          { time: "2026-06-15T20:00:00Z", score: 80 }, // 4 PM ET
          { time: "2026-06-15T21:00:00Z", score: 80 }, // 5 PM ET
        ],
      }),
      loc,
    );
    expect(s.bestWindow).toMatch(/–/);
  });
});
