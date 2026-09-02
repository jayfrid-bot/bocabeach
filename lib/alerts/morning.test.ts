// The home-beach alerts: the digest in the person's own number, and "your beach
// day just turned Excellent".

import { describe, it, expect } from "vitest";
import { computeScore, DEFAULT_SCORING } from "@/lib/score";
import { resolveScoring } from "@/lib/profile/resolve";
import { summarizeForPush } from "@/lib/push/notify";
import {
  excellentDecision,
  isDaylight,
  newSummaryCache,
  personalSummary,
  scoringFor,
} from "@/lib/alerts/morning";
import { defaultPrefs, type DeviceRecord, type ScoreProfile } from "@/lib/db/types";
import type { ConditionsResponse, ConditionsSnapshot, SunData } from "@/lib/types";
import {
  FIXTURE_SUNRISE,
  scorableResponse,
  scorableSnapshot,
  wrapped,
} from "@/lib/alerts/fixtures";

const NOW = Date.parse("2026-09-02T18:00:00Z"); // 2 PM ET, sun well up

const snapshot = scorableSnapshot;
const response = (s: ConditionsSnapshot): ConditionsResponse => ({
  ...scorableResponse(),
  snapshot: s,
});

function device(over: Partial<DeviceRecord> = {}): DeviceRecord {
  return {
    id: "dev-1",
    platform: "ios",
    tz: "America/New_York",
    homeSlug: "boca-raton",
    profile: null,
    prefs: defaultPrefs(),
    plan: "plus",
    entitlementUntil: NOW + 30 * 24 * 3600 * 1000,
    trialUsed: false,
    previewSeen: true,
    presence: null,
    ...over,
  };
}

const SURF: ScoreProfile = { profiles: ["surf"], heat: "normal", crowds: "normal" };
const LOC = { slug: "boca-raton", name: "Boca Raton", tz: "America/New_York" };

describe("scoringFor", () => {
  it("gives a profile-less device the free defaults", () => {
    expect(scoringFor(device())).toBe(DEFAULT_SCORING);
  });

  it("resolves a profile into its own options", () => {
    expect(scoringFor(device({ profile: SURF })).ideals.waveMode).toBe("surf");
  });
});

describe("personalSummary", () => {
  const res = response(snapshot());

  it("gives a profile-less device everyone's number", () => {
    const s = personalSummary(res, LOC, device(), NOW, newSummaryCache());
    expect(s.score).toBe(res.score.score);
  });

  it("gives a surfer a different number on the same day", () => {
    const mine = personalSummary(res, LOC, device({ profile: SURF }), NOW, newSummaryCache());
    const expected = computeScore(res.snapshot, resolveScoring(SURF));
    expect(mine.score).toBe(expected.score);
    expect(mine.score).not.toBe(res.score.score);
    expect(mine.rating).toBe(expected.rating);
  });

  it("re-scores once for two devices sharing a profile", () => {
    const cache = newSummaryCache();
    const a = personalSummary(res, LOC, device({ id: "a", profile: SURF }), NOW, cache);
    const b = personalSummary(res, LOC, device({ id: "b", profile: SURF }), NOW, cache);
    expect(cache.size).toBe(1);
    expect(a).toBe(b);
  });

  it("keeps everyone and a profile in separate cache slots", () => {
    const cache = newSummaryCache();
    personalSummary(res, LOC, device(), NOW, cache);
    personalSummary(res, LOC, device({ profile: SURF }), NOW, cache);
    expect(cache.size).toBe(2);
  });

  it("falls back to everyone's number when the snapshot cannot be re-scored", () => {
    // A snapshot missing a source the scorer reads: re-scoring throws, and the
    // person still gets their digest — just in everyone's number.
    const broken = {
      ...res,
      snapshot: { ...res.snapshot, hourly: undefined } as unknown as ConditionsSnapshot,
    };
    const s = summarizeForPush(broken, LOC, { scoring: resolveScoring(SURF), nowMs: NOW });
    expect(s.score).toBe(res.score.score);
  });
});

describe("isDaylight", () => {
  it("is true between sunrise and sunset", () => {
    expect(isDaylight(response(snapshot()), NOW)).toBe(true);
  });

  it("is false before sunrise", () => {
    expect(isDaylight(response(snapshot()), Date.parse("2026-09-02T09:00:00Z"))).toBe(false);
  });

  it("is false with no sun data", () => {
    const s = snapshot();
    const res = response({ ...s, sun: wrapped<SunData>(null) });
    expect(isDaylight(res, NOW)).toBe(false);
  });
});

describe("excellentDecision", () => {
  const res = response(snapshot());
  const summary = (score: number) => ({
    ...personalSummary(res, LOC, device(), NOW, newSummaryCache()),
    score,
  });

  it("fires once the day reaches 90", () => {
    const d = excellentDecision({ device: device(), summary: summary(92), res, nowMs: NOW, date: "2026-09-02" });
    expect(d?.dedupKey).toBe("score-excellent:2026-09-02");
    expect(d?.body).toBe("🏖️ Your beach day just turned Excellent at Boca Raton — 92/100.");
    expect(d?.tag).toBe("excellent");
  });

  it("stays quiet below 90", () => {
    expect(
      excellentDecision({ device: device(), summary: summary(89), res, nowMs: NOW, date: "2026-09-02" }),
    ).toBeNull();
  });

  it("stays quiet after dark", () => {
    const night = Date.parse("2026-09-03T03:00:00Z");
    expect(
      excellentDecision({ device: device(), summary: summary(95), res, nowMs: night, date: "2026-09-02" }),
    ).toBeNull();
  });

  it("respects the opt-out", () => {
    const prefs = defaultPrefs();
    prefs["score-excellent"] = false;
    expect(
      excellentDecision({
        device: device({ prefs }),
        summary: summary(95),
        res,
        nowMs: NOW,
        date: "2026-09-02",
      }),
    ).toBeNull();
  });

  it("uses a per-day key, so tomorrow can fire again", () => {
    const a = excellentDecision({ device: device(), summary: summary(95), res, nowMs: NOW, date: "2026-09-02" });
    const b = excellentDecision({ device: device(), summary: summary(95), res, nowMs: NOW, date: "2026-09-03" });
    expect(a?.dedupKey).not.toBe(b?.dedupKey);
  });
});
