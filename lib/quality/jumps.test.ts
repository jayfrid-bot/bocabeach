import { describe, expect, it } from "vitest";
import {
  biggestContributor,
  comparable,
  detectJumps,
  explainReasons,
  EXPLAIN_THRESHOLDS,
  JUMP_THRESHOLDS,
  type JumpRow,
} from "@/lib/quality/jumps";

const factors = (over: Record<string, number | null> = {}) =>
  JSON.stringify(
    Object.entries({ airTemp: 90, sky: 90, wind: 90, waves: 90, ...over }).map(([key, score]) => ({
      key,
      label: key,
      score,
      weight: 0.25,
    })),
  );

function row(over: Partial<JumpRow> = {}): JumpRow {
  return {
    slug: "boca-raton",
    hour_utc: "2026-10-13T16:00:00.000Z",
    score: 80,
    wave_ft: 2,
    surf_ft: 2,
    wave_source: "model",
    sand_temp_f: 90,
    clarity_pct: 80,
    rain_now: 0,
    lightning_near: 0,
    wind_mph: 10,
    cloud_pct: 20,
    caps_json: "[]",
    factors_json: factors(),
    ...over,
  };
}
const next = (over: Partial<JumpRow> = {}) => row({ hour_utc: "2026-10-13T17:00:00.000Z", ...over });

describe("thresholds", () => {
  it("are the numbers the plan names", () => {
    expect(JUMP_THRESHOLDS).toEqual({ scoreDrop: 15, surfFt: 2, sandF: 10, clarityDrop: 15 });
    expect(EXPLAIN_THRESHOLDS).toEqual({ windMph: 5, cloudPct: 30 });
  });
});

describe("detectJumps: what counts as a jump", () => {
  it("finds nothing when nothing moved", () => {
    expect(detectJumps(row(), next())).toEqual([]);
  });

  it("score: a drop of 15 or more, not 14, and never a rise", () => {
    expect(detectJumps(row(), next({ score: 65 }))[0]).toMatchObject({ signal: "score", from: 80, to: 65, delta: -15 });
    expect(detectJumps(row(), next({ score: 66 }))).toEqual([]);
    expect(detectJumps(row(), next({ score: 99 }))).toEqual([]);
  });

  it("surf: a change of 2 ft or more in either direction", () => {
    expect(detectJumps(row(), next({ surf_ft: 4 }))[0]).toMatchObject({ signal: "surf", from: 2, to: 4, delta: 2 });
    expect(detectJumps(row({ surf_ft: 5 }), next({ surf_ft: 3 }))[0]).toMatchObject({ signal: "surf", delta: -2 });
    expect(detectJumps(row(), next({ surf_ft: 3.9 }))).toEqual([]);
  });

  it("surf: uses raw wave height when a row has no surf estimate, and skips when neither pair is complete", () => {
    const a = row({ surf_ft: null, wave_ft: 1 });
    expect(detectJumps(a, next({ surf_ft: null, wave_ft: 3.5 }))[0]).toMatchObject({ signal: "surf", from: 1, to: 3.5 });
    expect(detectJumps(row({ surf_ft: null, wave_ft: null }), next({ surf_ft: 9 }))).toEqual([]);
  });

  it("sand: a change of 10 F or more in either direction", () => {
    expect(detectJumps(row(), next({ sand_temp_f: 100 }))[0]).toMatchObject({ signal: "sand", delta: 10 });
    expect(detectJumps(row(), next({ sand_temp_f: 80 }))[0]).toMatchObject({ signal: "sand", delta: -10 });
    expect(detectJumps(row(), next({ sand_temp_f: 99 }))).toEqual([]);
  });

  it("clarity: a drop of 15 points or more, never a rise", () => {
    expect(detectJumps(row(), next({ clarity_pct: 65 }))[0]).toMatchObject({ signal: "clarity", delta: -15 });
    expect(detectJumps(row(), next({ clarity_pct: 66 }))).toEqual([]);
    expect(detectJumps(row(), next({ clarity_pct: 100 }))).toEqual([]);
  });

  it("ignores a signal that is missing in either hour", () => {
    expect(detectJumps(row({ score: null }), next({ score: 10 }))).toEqual([]);
    expect(detectJumps(row(), next({ sand_temp_f: null }))).toEqual([]);
    expect(detectJumps(row({ clarity_pct: null }), next({ clarity_pct: 0 }))).toEqual([]);
  });

  it("reports several jumps in one hour", () => {
    const got = detectJumps(row(), next({ score: 50, sand_temp_f: 70, clarity_pct: 40 }));
    expect(got.map((d) => d.signal).sort()).toEqual(["clarity", "sand", "score"]);
  });
});

describe("comparable: which two rows may be compared", () => {
  it("accepts the next hour and a one-hour gap, refuses the rest", () => {
    expect(comparable(row(), next())).toBe(true);
    expect(comparable(row(), row({ hour_utc: "2026-10-13T18:00:00.000Z" }))).toBe(true); // one missed hour
    expect(comparable(row(), row({ hour_utc: "2026-10-13T19:00:00.000Z" }))).toBe(false); // 3 hours
    expect(comparable(row(), row())).toBe(false); // same hour
    expect(comparable(next(), row())).toBe(false); // backwards
    expect(comparable(row(), next({ slug: "deerfield-beach" }))).toBe(false);
    expect(comparable(row({ hour_utc: "not a date" }), next())).toBe(false);
  });

  it("finds no jump across rows that are not comparable", () => {
    expect(detectJumps(row(), row({ hour_utc: "2026-10-13T22:00:00.000Z", score: 10 }))).toEqual([]);
  });
});

describe("biggestContributor", () => {
  it("names the factor whose share of the score moved most", () => {
    const got = biggestContributor(factors(), factors({ waves: 10 }));
    expect(got).toEqual({ key: "waves", label: "waves", delta: -20 });
  });

  it("renormalizes: a factor that loses its data hands its weight to the rest", () => {
    // wind drops out; the other three share 100% of the weight.
    const got = biggestContributor(factors({ wind: 100 }), factors({ wind: null }));
    expect(got?.key).toBe("wind");
    expect(got!.delta).toBeLessThan(0);
  });

  it("is null when either hour has no usable breakdown", () => {
    expect(biggestContributor(null, factors())).toBeNull();
    expect(biggestContributor(factors(), "not json")).toBeNull();
    expect(biggestContributor("[]", factors())).toBeNull();
  });

  it("names the cause on a score jump", () => {
    const [d] = detectJumps(row(), next({ score: 60, factors_json: factors({ sky: 10 }) }));
    expect(d.cause?.key).toBe("sky");
  });
});

describe("explainReasons: what stops an alert", () => {
  const explain = (signal: Parameters<typeof explainReasons>[0], over: Partial<JumpRow>, cause = null as Parameters<typeof explainReasons>[3]) =>
    explainReasons(signal, row(), next(over), cause);

  it("rain: rain_now changed either way", () => {
    expect(explain("score", { rain_now: 1 })).toContain("rain");
    expect(explain("score", {}) ).toEqual([]);
    expect(explainReasons("score", row({ rain_now: 1 }), next({ rain_now: 0 }), null)).toContain("rain");
    expect(explainReasons("score", row({ rain_now: 1 }), next({ rain_now: 1 }), null)).not.toContain("rain");
  });

  it("lightning: lightning_near changed", () => {
    expect(explain("score", { lightning_near: 1 })).toContain("lightning");
  });

  it("caps: the set of active caps changed; a changing number inside a cap does not count", () => {
    const a = row({ caps_json: JSON.stringify(["Red flag — high hazard, swimming discouraged"]) });
    expect(explainReasons("score", row(), next({ caps_json: a.caps_json }), null)).toContain("caps");
    const covA = JSON.stringify(["Severe — ~35% of the beach covered"]);
    const covB = JSON.stringify(["Severe — ~42% of the beach covered"]);
    expect(explainReasons("score", row({ caps_json: covA }), next({ caps_json: covB }), null)).not.toContain("caps");
    expect(explainReasons("score", row({ caps_json: covA }), next({ caps_json: "[]" }), null)).toContain("caps");
  });

  it("wind: 5 mph or more, either way; 4.9 does not", () => {
    expect(explain("sand", { wind_mph: 15 })).toContain("wind");
    expect(explain("sand", { wind_mph: 5 })).toContain("wind");
    expect(explain("sand", { wind_mph: 14.9 })).not.toContain("wind");
    expect(explain("sand", { wind_mph: 5.1 })).not.toContain("wind");
  });

  it("official observation: a buoy wave reading explains a surf jump or a score jump led by the waves", () => {
    const cause = { key: "waves", label: "waves", delta: -20 };
    expect(explain("surf", { wave_source: "observed" })).toContain("official-observation");
    expect(explain("score", { wave_source: "observed" }, cause)).toContain("official-observation");
    expect(explain("score", { wave_source: "observed" }, { key: "sky", label: "sky", delta: -20 })).not.toContain("official-observation");
    expect(explain("surf", { wave_source: "model" })).toEqual([]);
    expect(explain("clarity", { wave_source: "observed" })).toEqual([]);
  });

  it("cloud: a 30 point swing explains a sand jump, or a score jump led by the sky, and nothing else", () => {
    const sky = { key: "sky", label: "sky", delta: -20 };
    expect(explain("sand", { cloud_pct: 50 })).toContain("cloud");
    expect(explain("sand", { cloud_pct: 49 })).not.toContain("cloud");
    expect(explain("score", { cloud_pct: 80 }, sky)).toContain("cloud");
    expect(explain("score", { cloud_pct: 80 }, { key: "waves", label: "waves", delta: -20 })).not.toContain("cloud");
    expect(explain("clarity", { cloud_pct: 90 })).not.toContain("cloud");
    expect(explain("surf", { cloud_pct: 90 })).not.toContain("cloud");
  });
});

describe("detectJumps: explained or not", () => {
  it("marks a rain-driven score drop explained, with its reason", () => {
    const [d] = detectJumps(row(), next({ score: 55, rain_now: 1 }));
    expect(d).toMatchObject({ signal: "score", explained: true, reasons: ["rain"] });
  });

  it("leaves an unexplained drop unexplained", () => {
    const [d] = detectJumps(row(), next({ score: 55, factors_json: factors({ airTemp: 20, sky: 20 }) }));
    expect(d.explained).toBe(false);
    expect(d.reasons).toEqual([]);
  });

  it("explains one jump in an hour and not another", () => {
    const got = detectJumps(row(), next({ score: 50, wind_mph: 16, clarity_pct: 40, wave_source: "model" }));
    // wind moved 6 mph, so every jump this hour carries the wind reason
    expect(got.every((d) => d.explained)).toBe(true);
    const got2 = detectJumps(row(), next({ score: 50, clarity_pct: 40 }));
    expect(got2.every((d) => !d.explained)).toBe(true);
  });
});
