// The at-beach rules, one fixture per catalog key: what fires, what stays quiet,
// what a preference switches off, and what a surfing profile softens.

import { describe, it, expect } from "vitest";
import { evaluateAtBeach, type AtBeachInput } from "@/lib/alerts/evaluate";
import { conditionsFixture, type ConditionsOver } from "@/lib/alerts/fixtures";
import { defaultPrefs, type AlertPrefs, type ScoreProfile } from "@/lib/db/types";
import type { RainRead } from "@/lib/alerts/rain";
import type { LightningData } from "@/lib/types";

const NOW = Date.parse("2026-09-02T18:00:00Z"); // 2 PM ET

function strikes(over: Partial<LightningData>): LightningData {
  return {
    within10mi: 1,
    within20mi: 1,
    within25mi: 1,
    within50mi: 1,
    totalInArea: 1,
    stormEnergy: 1,
    ...over,
  } as LightningData;
}

/** Everything of AtBeachInput, except `conditions` comes in as fixture overrides. */
type EvalOver = Omit<Partial<AtBeachInput>, "conditions"> & { conditions?: ConditionsOver | null };

function input(over: EvalOver = {}): AtBeachInput {
  const { conditions, ...rest } = over;
  return {
    now: NOW,
    device: { prefs: defaultPrefs(), profile: null },
    presence: { slug: "boca-raton", lat: 26.35, lon: -80.07 },
    beachName: "Boca Raton",
    strikes: null,
    rain: null,
    conditions: conditions === null ? null : conditionsFixture(conditions ?? {}),
    ...rest,
  };
}

const keys = (ds: { dedupKey: string }[]): string[] => ds.map((d) => d.dedupKey);
const bodyOf = (ds: { dedupKey: string; body: string }[], key: string): string | undefined =>
  ds.find((d) => d.dedupKey === key)?.body;

function prefsWithout(key: keyof AlertPrefs): AlertPrefs {
  const p = defaultPrefs();
  p[key] = false;
  return p;
}

const SURF: ScoreProfile = { profiles: ["surf"], heat: "normal", crowds: "normal" };
const SWIM: ScoreProfile = { profiles: ["swim"], heat: "normal", crowds: "normal" };

describe("evaluateAtBeach — a quiet beach", () => {
  it("says nothing when nothing is happening", () => {
    expect(evaluateAtBeach(input())).toEqual([]);
  });
});

describe("evaluateAtBeach — lightning, from the person's own fix", () => {
  it("fires inside 5 miles, with the distance to one decimal", () => {
    const out = evaluateAtBeach(
      input({ strikes: strikes({ nearestMi: 3.24, nearestMinutesAgo: 4 }) }),
    );
    expect(keys(out)).toEqual(["lightning"]);
    expect(out[0].body).toBe("⚡ Lightning 3.2 mi away — get out of the water and take cover.");
    expect(out[0].title).toBe("⚠️ Boca Raton");
  });

  it("stays quiet beyond 5 miles", () => {
    const out = evaluateAtBeach(input({ strikes: strikes({ nearestMi: 7.1, nearestMinutesAgo: 2 }) }));
    expect(out).toEqual([]);
  });

  it("stays quiet on a strike older than 30 minutes", () => {
    const out = evaluateAtBeach(input({ strikes: strikes({ nearestMi: 2.0, nearestMinutesAgo: 45 }) }));
    expect(out).toEqual([]);
  });

  it("escalates inside 2 miles, and the escalation replaces the plain alert", () => {
    const out = evaluateAtBeach(input({ strikes: strikes({ nearestMi: 1.4, nearestMinutesAgo: 1 }) }));
    expect(keys(out)).toEqual(["lightning", "lightning:2mi"]); // both offered
    const esc = out.find((d) => d.dedupKey === "lightning:2mi")!;
    expect(esc.body).toBe("⚡ Lightning within 2 miles — take cover now.");
    expect(esc.supersedes).toEqual(["lightning"]); // dedup drops the quieter one
  });

  it("respects the lightning opt-out", () => {
    const out = evaluateAtBeach(
      input({
        strikes: strikes({ nearestMi: 1.0, nearestMinutesAgo: 1 }),
        device: { prefs: prefsWithout("lightning"), profile: null },
      }),
    );
    expect(out).toEqual([]);
  });
});

describe("evaluateAtBeach — the snapshot hazards", () => {
  it("names a severe warning", () => {
    const out = evaluateAtBeach(
      input({ conditions: { alerts: [{ event: "Tornado Warning", severity: "Extreme" }] } }),
    );
    expect(keys(out)).toEqual(["severe:Tornado Warning"]);
    expect(out[0].body).toBe("Tornado Warning in effect at Boca Raton.");
  });

  it("carries a Beach Hazards Statement through as its own event", () => {
    const out = evaluateAtBeach(
      input({ conditions: { alerts: [{ event: "Beach Hazards Statement", severity: "Moderate" }] } }),
    );
    expect(out[0].body).toBe("Beach Hazards Statement in effect at Boca Raton.");
  });

  it("fires a thunderstorm alert off a corroborated storm code", () => {
    const out = evaluateAtBeach(
      input({
        conditions: {
          hourly: [{ time: "2026-09-02T18:00:00.000Z", weatherCode: 95, precipProbability: 70 }],
        },
      }),
    );
    expect(keys(out)).toEqual(["thunder"]);
    expect(out[0].body).toBe("⛈️ Thunderstorm approaching Boca Raton.");
  });

  it("ignores an uncorroborated storm code", () => {
    const out = evaluateAtBeach(
      input({
        conditions: {
          hourly: [{ time: "2026-09-02T18:00:00.000Z", weatherCode: 95, precipProbability: 2 }],
        },
      }),
    );
    expect(out).toEqual([]);
  });

  it("does not say thunderstorm twice when the warning already did", () => {
    const out = evaluateAtBeach(
      input({
        conditions: {
          alerts: [{ event: "Severe Thunderstorm Warning", severity: "Severe" }],
          hourly: [{ time: "2026-09-02T18:00:00.000Z", weatherCode: 95, precipProbability: 80 }],
        },
      }),
    );
    expect(keys(out)).toEqual(["severe:Severe Thunderstorm Warning"]);
  });

  it("flags a water-quality advisory", () => {
    const out = evaluateAtBeach(input({ conditions: { waterAdvisory: true } }));
    expect(keys(out)).toEqual(["water-advisory"]);
    expect(out[0].body).toBe("Water-quality advisory at Boca Raton — swimming not recommended.");
  });

  it("flags a high rip current", () => {
    const out = evaluateAtBeach(input({ conditions: { rip: "high" } }));
    expect(keys(out)).toEqual(["rip"]);
    expect(out[0].body).toBe("High rip-current risk at Boca Raton — swim near a lifeguard.");
  });

  it("gives a moderate rip its own key, so an upgrade to high is not deduped away", () => {
    const out = evaluateAtBeach(input({ conditions: { rip: "moderate" } }));
    expect(keys(out)).toEqual(["rip:moderate"]);
  });

  it("flags a red flag", () => {
    const out = evaluateAtBeach(input({ conditions: { flags: ["red"] } }));
    expect(keys(out)).toEqual(["flag:red"]);
    expect(out[0].body).toBe("🚩 Red flag flying at Boca Raton — dangerous surf, stay out.");
  });

  it("says double red closes the beach", () => {
    const out = evaluateAtBeach(input({ conditions: { flags: ["double-red"] } }));
    expect(keys(out)).toEqual(["flag:double-red"]);
    expect(out[0].body).toBe("🚩 Double red flag at Boca Raton — beach closed to swimming.");
  });

  it("respects a hazard opt-out", () => {
    const out = evaluateAtBeach(
      input({
        conditions: { rip: "high" },
        device: { prefs: prefsWithout("rip"), profile: null },
      }),
    );
    expect(out).toEqual([]);
  });
});

describe("evaluateAtBeach — wind", () => {
  it("fires above 25 mph gusts", () => {
    const out = evaluateAtBeach(input({ conditions: { gustMph: 28 } }));
    expect(keys(out)).toEqual(["wind-gust"]);
    expect(out[0].body).toBe("💨 Gusts over 25 mph at Boca Raton.");
    expect(out[0].title).toBe("Boca Raton"); // news, not an alarm
  });

  it("stays quiet at 25 mph", () => {
    expect(evaluateAtBeach(input({ conditions: { gustMph: 25 } }))).toEqual([]);
  });
});

describe("evaluateAtBeach — rain", () => {
  const rain = (over: Partial<RainRead>): RainRead => ({
    etaMinutes: null,
    rainingNow: false,
    clearingSoon: false,
    source: "forecast",
    ...over,
  });

  it("warns about rain arriving inside 30 minutes", () => {
    const out = evaluateAtBeach(input({ rain: rain({ etaMinutes: 12 }) }));
    expect(keys(out)).toEqual(["rain-soon"]);
    expect(out[0].body).toBe("🌧️ Rain in about 12 minutes where you are.");
  });

  it("stays quiet when the rain is further out", () => {
    expect(evaluateAtBeach(input({ rain: rain({ etaMinutes: 50 }) }))).toEqual([]);
  });

  it("stays quiet when it is already raining on them", () => {
    expect(evaluateAtBeach(input({ rain: rain({ etaMinutes: 5, rainingNow: true }) }))).toEqual([]);
  });

  it("says it is clearing only to someone who was warned or rained on", () => {
    const clearing = rain({ clearingSoon: true });
    expect(evaluateAtBeach(input({ rain: clearing }))).toEqual([]); // out of nowhere → silence

    const afterWarning = evaluateAtBeach(
      input({ rain: clearing, recentRain: { soonAt: NOW - 40 * 60_000, wetAt: null } }),
    );
    expect(keys(afterWarning)).toEqual(["rain-clearing"]);
    expect(afterWarning[0].body).toBe("☀️ Rain clearing — the beach should dry out soon.");

    const afterGettingWet = evaluateAtBeach(
      input({ rain: clearing, recentRain: { soonAt: null, wetAt: NOW - 20 * 60_000 } }),
    );
    expect(keys(afterGettingWet)).toEqual(["rain-clearing"]);
  });

  it("forgets a rain warning older than the memory window", () => {
    const out = evaluateAtBeach(
      input({
        rain: rain({ clearingSoon: true }),
        recentRain: { soonAt: NOW - 5 * 3600_000, wetAt: null },
      }),
    );
    expect(out).toEqual([]);
  });
});

describe("evaluateAtBeach — the profile filter", () => {
  it("gives a surfer a red flag as news, not an alarm", () => {
    const out = evaluateAtBeach(
      input({ conditions: { flags: ["red"] }, device: { prefs: defaultPrefs(), profile: SURF } }),
    );
    expect(out[0].title).toBe("Boca Raton");
    expect(out[0].body).toBe("🚩 Conditions changed: red flag flying at Boca Raton.");
  });

  it("gives a surfer a high rip as news too", () => {
    const out = evaluateAtBeach(
      input({ conditions: { rip: "high" }, device: { prefs: defaultPrefs(), profile: SURF } }),
    );
    expect(out[0].title).toBe("Boca Raton");
    expect(out[0].body).toBe("Conditions changed: high rip-current risk at Boca Raton.");
  });

  it("still alarms a surfer on a double red — that is a closed beach", () => {
    const out = evaluateAtBeach(
      input({
        conditions: { flags: ["double-red"] },
        device: { prefs: defaultPrefs(), profile: SURF },
      }),
    );
    expect(out[0].title).toBe("⚠️ Boca Raton");
  });

  it("still alarms a surfer on lightning — safety is never personal", () => {
    const out = evaluateAtBeach(
      input({
        strikes: strikes({ nearestMi: 3, nearestMinutesAgo: 1 }),
        device: { prefs: defaultPrefs(), profile: SURF },
      }),
    );
    expect(out[0].title).toBe("⚠️ Boca Raton");
  });

  it("keeps the alarm for a swimming profile", () => {
    const out = evaluateAtBeach(
      input({ conditions: { flags: ["red"] }, device: { prefs: defaultPrefs(), profile: SWIM } }),
    );
    expect(out[0].title).toBe("⚠️ Boca Raton");
    expect(out[0].body).toBe("🚩 Red flag flying at Boca Raton — dangerous surf, stay out.");
  });
});

describe("evaluateAtBeach — ordering", () => {
  it("puts the most urgent alert first", () => {
    const out = evaluateAtBeach(
      input({
        strikes: strikes({ nearestMi: 4, nearestMinutesAgo: 2 }),
        rain: { etaMinutes: 10, rainingNow: false, clearingSoon: false, source: "radar" },
        conditions: { rip: "high", gustMph: 30 },
      }),
    );
    expect(keys(out)).toEqual(["lightning", "rip", "wind-gust", "rain-soon"]);
  });

  it("survives a missing conditions snapshot", () => {
    const out = evaluateAtBeach(
      input({ strikes: strikes({ nearestMi: 1, nearestMinutesAgo: 1 }), conditions: null }),
    );
    expect(keys(out)).toEqual(["lightning", "lightning:2mi"]);
    expect(bodyOf(out, "lightning")).toContain("1.0 mi away");
  });
});
