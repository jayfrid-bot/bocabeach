import { describe, expect, it } from "vitest";
import {
  CAUSE_MATRIX,
  comparable,
  detectJumps,
  explainReasons,
  EXPLAIN_THRESHOLDS,
  JUMP_THRESHOLDS,
  largestDecline,
  type FactorCause,
  type JumpRow,
  type JumpSignal,
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
    local_date: "2026-10-13",
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

describe("largestDecline: the cause of a score drop is something that went DOWN", () => {
  it("names the factor whose share of the score fell most", () => {
    expect(largestDecline(factors(), factors({ waves: 10 }))).toEqual({ key: "waves", label: "waves", delta: -20 });
  });

  it("never names a factor that improved, even when it improved the most (Codex: waves +25, others -20)", () => {
    // prev: every factor 50. cur: waves 100, the other three 10: waves rose, three fell.
    const prev = factors({ airTemp: 50, sky: 50, wind: 50, waves: 50 });
    const cur = factors({ airTemp: 10, sky: 10, wind: 10, waves: 100 });
    const got = largestDecline(prev, cur)!;
    expect(got.key).not.toBe("waves");
    expect(got.delta).toBeLessThan(0);
  });

  it("is null when nothing fell, or either hour has no usable breakdown", () => {
    expect(largestDecline(factors(), factors())).toBeNull();
    expect(largestDecline(factors({ waves: 10 }), factors())).toBeNull();
    expect(largestDecline(null, factors())).toBeNull();
    expect(largestDecline(factors(), "not json")).toBeNull();
    expect(largestDecline("[]", factors())).toBeNull();
  });

  it("a factor that loses its data hands its weight to the rest", () => {
    // wind drops out; the other three share 100% of the weight, so each of THEM rises and wind falls.
    const got = largestDecline(factors({ wind: 100 }), factors({ wind: null }));
    expect(got?.key).toBe("wind");
  });

  it("names the cause on a score jump", () => {
    const [d] = detectJumps(row(), next({ score: 60, factors_json: factors({ sky: 10 }) }));
    expect(d.cause?.key).toBe("sky");
  });
});

describe("the signal-to-cause matrix", () => {
  it("is the one the plan names", () => {
    expect(CAUSE_MATRIX).toEqual({
      score: ["rain", "lightning", "caps", "wind", "official-observation", "cloud"],
      clarity: ["rain", "lightning", "wind"],
      surf: ["wind", "official-observation"],
      sand: ["rain", "cloud"],
    });
  });

  const sky = { key: "sky", label: "sky", delta: -20 };
  const waves = { key: "waves", label: "waves", delta: -20 };
  const explain = (signal: JumpSignal, over: Partial<JumpRow>, cause: FactorCause | null = null, delta = -20) =>
    explainReasons(signal, row(), next(over), cause, delta);
  const capRow = JSON.stringify(["Red flag — high hazard, swimming discouraged"]);

  it("rain explains score, clarity and a cooling of the sand; never surf", () => {
    expect(explain("score", { rain_now: 1 })).toContain("rain");
    expect(explain("clarity", { rain_now: 1 })).toContain("rain");
    expect(explain("sand", { rain_now: 1 }, null, -12)).toContain("rain");
    expect(explain("sand", { rain_now: 1 }, null, +12)).not.toContain("rain");
    expect(explain("surf", { rain_now: 1 }, null, 3)).toEqual([]);
  });

  it("rain only explains when it STARTED", () => {
    expect(explainReasons("score", row({ rain_now: 1 }), next({ rain_now: 0 }), null, -20)).not.toContain("rain");
    expect(explainReasons("score", row({ rain_now: 1 }), next({ rain_now: 1 }), null, -20)).not.toContain("rain");
    expect(explainReasons("score", row({ rain_now: null }), next({ rain_now: 1 }), null, -20)).not.toContain("rain");
  });

  it("lightning explains score and clarity only, and only when it started", () => {
    expect(explain("score", { lightning_near: 1 })).toContain("lightning");
    expect(explain("clarity", { lightning_near: 1 })).toContain("lightning");
    expect(explain("surf", { lightning_near: 1 }, null, 3)).toEqual([]);
    expect(explain("sand", { lightning_near: 1 }, null, 12)).toEqual([]);
    expect(explainReasons("score", row({ lightning_near: 1 }), next({ lightning_near: 0 }), null, -20)).not.toContain("lightning");
  });

  it("a cap that was ADDED explains a score drop and nothing else: it cannot hide a clarity, surf or sand anomaly", () => {
    expect(explain("score", { caps_json: capRow })).toContain("caps");
    for (const sig of ["clarity", "surf", "sand"] as const) expect(explain(sig, { caps_json: capRow }, null, sig === "surf" ? 3 : -20)).toEqual([]);
  });

  it("a cap that was removed, or only changed a number, explains nothing", () => {
    const covA = JSON.stringify(["Severe — ~35% of the beach covered"]);
    const covB = JSON.stringify(["Severe — ~42% of the beach covered"]);
    expect(explainReasons("score", row({ caps_json: covA }), next({ caps_json: covB }), null, -20)).not.toContain("caps");
    expect(explainReasons("score", row({ caps_json: capRow }), next({ caps_json: "[]" }), null, -20)).not.toContain("caps");
  });

  it("wind explains score, surf and clarity; 5 mph is enough, 4.9 is not; never sand", () => {
    for (const sig of ["score", "clarity", "surf"] as const) expect(explain(sig, { wind_mph: 15 }, null, sig === "surf" ? 3 : -20)).toContain("wind");
    expect(explain("score", { wind_mph: 15 })).toContain("wind");
    expect(explain("score", { wind_mph: 5 })).toContain("wind");
    expect(explain("score", { wind_mph: 14.9 })).not.toContain("wind");
    expect(explain("score", { wind_mph: 5.1 })).not.toContain("wind");
    expect(explain("sand", { wind_mph: 20 }, null, -12)).toEqual([]);
  });

  it("a buoy reading explains surf, and a score drop that the WAVES led; not a score drop another factor led", () => {
    expect(explain("surf", { wave_source: "observed" }, null, 3)).toContain("official-observation");
    expect(explain("score", { wave_source: "observed" }, waves)).toContain("official-observation");
    expect(explain("score", { wave_source: "observed" }, sky)).not.toContain("official-observation");
    expect(explain("score", { wave_source: "observed" }, null)).not.toContain("official-observation");
    expect(explain("surf", { wave_source: "model" }, null, 3)).toEqual([]);
    expect(explain("clarity", { wave_source: "observed" })).toEqual([]);
    expect(explain("sand", { wave_source: "observed" }, null, -12)).toEqual([]);
  });

  it("cloud explains a cooling sand jump when cloud rose, and a sky-led score drop when cloud rose", () => {
    expect(explain("sand", { cloud_pct: 50 }, null, -12)).toContain("cloud");
    expect(explain("sand", { cloud_pct: 49 }, null, -12)).not.toContain("cloud");
    // sand that WARMED while the sky clouded over is not explained by the clouds
    expect(explain("sand", { cloud_pct: 80 }, null, +12)).not.toContain("cloud");
    // and sand that warmed because the sky CLEARED is
    expect(explainReasons("sand", row({ cloud_pct: 80 }), next({ cloud_pct: 20 }), null, +12)).toContain("cloud");
    expect(explain("score", { cloud_pct: 80 }, sky)).toContain("cloud");
    expect(explain("score", { cloud_pct: 80 }, waves)).not.toContain("cloud");
    // a drop in cloud cover cannot explain a drop in the sky factor
    expect(explainReasons("score", row({ cloud_pct: 80 }), next({ cloud_pct: 20 }), sky, -20)).not.toContain("cloud");
    expect(explain("clarity", { cloud_pct: 90 })).toEqual([]);
    expect(explain("surf", { cloud_pct: 90 }, null, 3)).toEqual([]);
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

  it("a cap change hides the score drop it caused but NOT an unrelated clarity drop in the same hour", () => {
    const got = detectJumps(row(), next({ score: 50, clarity_pct: 40, caps_json: JSON.stringify(["Red flag — high hazard, swimming discouraged"]) }));
    expect(got.find((d) => d.signal === "score")?.explained).toBe(true);
    expect(got.find((d) => d.signal === "clarity")?.explained).toBe(false);
  });

  it("rain hides a clarity drop but not a surf jump", () => {
    const got = detectJumps(row(), next({ clarity_pct: 40, surf_ft: 6, rain_now: 1 }));
    expect(got.find((d) => d.signal === "clarity")?.explained).toBe(true);
    expect(got.find((d) => d.signal === "surf")?.explained).toBe(false);
  });

  it("an observed buoy does not excuse a score drop that three other factors caused (Codex)", () => {
    const prev = row({ factors_json: factors({ airTemp: 50, sky: 50, wind: 50, waves: 50 }) });
    const cur = next({
      score: 55,
      wave_source: "observed",
      factors_json: factors({ airTemp: 10, sky: 10, wind: 10, waves: 100 }),
    });
    const [d] = detectJumps(prev, cur);
    expect(d.signal).toBe("score");
    expect(d.cause?.key).not.toBe("waves");
    expect(d.explained).toBe(false);
  });
});
