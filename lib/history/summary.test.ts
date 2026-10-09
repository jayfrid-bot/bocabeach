import { describe, it, expect } from "vitest";
import {
  daysBetweenLocalDates,
  recordsFormulaInfo,
  recordsFromRows,
  shiftLocalDate,
  shortMonthDay,
  summarizeHistory,
  summarizeVersions,
  weekdayLongOf,
  weekdayOf,
} from "@/lib/history/summary";
import type { BeachHourlyRow, HistoryRecordRow } from "@/lib/history/types";

function row(over: Partial<BeachHourlyRow> = {}): BeachHourlyRow {
  return {
    slug: "boca-raton",
    hour_utc: "2026-09-22T14:00:00.000Z",
    snapshot_generated_at: "2026-09-22T14:05:00.000Z",
    archived_at: "2026-09-22T14:05:01.000Z",
    local_date: "2026-09-22",
    local_hour: 10,
    utc_offset_minutes: -240,
    timezone: "America/New_York",
    score: 80,
    raw_score: 80,
    rating: "Good",
    available_weight: 1,
    observed_weight: 0.2,
    coverage_tier: "full",
    air_temp_f: 85,
    water_temp_f: 84,
    sand_temp_f: 95,
    wave_ft: 2,
    surf_ft: null,
    wave_source: "model",
    wind_mph: 8,
    gust_mph: 12,
    uv: 6,
    cloud_pct: 10,
    rain_now: 0,
    lightning_near: 0,
    tide_state: "rising",
    crowd_pct: null,
    seaweed_pct: 5,
    seaweed_level: "low",
    clarity_pct: null,
    engine_version: "test-1",
    scoring_config_version: "test-1",
    build_sha: "abc123",
    row_kind: "snapshot",
    archive_reason: "cron",
    caps_json: "[]",
    factors_json: "[]",
    missing_json: "[]",
    extra_json: null,
    ...over,
  };
}

function recordRow(over: Partial<HistoryRecordRow> & { kind: HistoryRecordRow["kind"] }): HistoryRecordRow {
  return { local_date: "2026-09-22", local_hour: 10, value: 0, engine_version: "test-1", ...over };
}

describe("weekdayOf / weekdayLongOf", () => {
  it("labels a known date correctly, short and long", () => {
    // 2026-09-22 is a Tuesday.
    expect(weekdayOf("2026-09-22")).toBe("Tue");
    expect(weekdayLongOf("2026-09-22")).toBe("Tuesday");
    // 2026-09-28 (today, per the app's own clock) is a Monday.
    expect(weekdayOf("2026-09-28")).toBe("Mon");
    expect(weekdayLongOf("2026-09-28")).toBe("Monday");
  });

  it("returns '' for a malformed date rather than throwing", () => {
    expect(weekdayOf("not-a-date")).toBe("");
    expect(weekdayLongOf("not-a-date")).toBe("");
  });
});

describe("shortMonthDay", () => {
  it("uses 'Sept', not Intl's 3-letter 'Sep'", () => {
    expect(shortMonthDay("2026-09-22")).toBe("Sept 22");
  });

  it("uses the ordinary 3-letter abbreviation for every other month", () => {
    expect(shortMonthDay("2026-01-05")).toBe("Jan 5");
    expect(shortMonthDay("2026-12-31")).toBe("Dec 31");
  });
});

describe("shiftLocalDate", () => {
  it("shifts back within a month", () => {
    expect(shiftLocalDate("2026-09-28", -6)).toBe("2026-09-22");
  });

  it("shifts back across a month boundary", () => {
    expect(shiftLocalDate("2026-09-03", -6)).toBe("2026-08-28");
  });

  it("a zero shift is a no-op", () => {
    expect(shiftLocalDate("2026-09-28", 0)).toBe("2026-09-28");
  });
});

describe("daysBetweenLocalDates", () => {
  it("counts whole calendar days, positive when b is later", () => {
    expect(daysBetweenLocalDates("2026-09-22", "2026-09-28")).toBe(6);
    expect(daysBetweenLocalDates("2026-09-22", "2026-10-06")).toBe(14);
  });

  it("is negative when b is earlier, and zero for the same date", () => {
    expect(daysBetweenLocalDates("2026-09-28", "2026-09-22")).toBe(-6);
    expect(daysBetweenLocalDates("2026-09-22", "2026-09-22")).toBe(0);
  });
});

describe("summarizeHistory — empty input", () => {
  it("returns no days", () => {
    expect(summarizeHistory([])).toEqual([]);
  });
});

describe("summarizeHistory — one hour", () => {
  it("a single row makes a single, partial day whose best/worst/avg all equal that one score", () => {
    const days = summarizeHistory([row({ score: 72, local_hour: 14 })]);
    expect(days).toHaveLength(1);
    const d = days[0];
    expect(d.date).toBe("2026-09-22");
    expect(d.weekday).toBe("Tue");
    expect(d.hours).toBe(1);
    expect(d.best).toEqual({ score: 72, localHour: 14 });
    expect(d.worst).toEqual({ score: 72, localHour: 14 });
    expect(d.avg).toBe(72);
    expect(d.partial).toBe(true); // fewer than 6 scored hours
  });
});

describe("summarizeHistory — partial vs full day", () => {
  it("flags a day with fewer than 6 scored hours partial", () => {
    const rows = [0, 1, 2, 3, 4].map((h) => row({ local_hour: h, score: 50 + h }));
    const days = summarizeHistory(rows);
    expect(days[0].hours).toBe(5);
    expect(days[0].partial).toBe(true);
  });

  it("a day with exactly 6 scored hours is NOT partial", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((h) => row({ local_hour: h, score: 50 + h }));
    const days = summarizeHistory(rows);
    expect(days[0].hours).toBe(6);
    expect(days[0].partial).toBe(false);
  });

  it("a row with no score at all doesn't count toward 'hours' but still contributes its other fields", () => {
    const rows = [
      row({ local_hour: 8, score: null, air_temp_f: 90 }),
      ...[9, 10, 11, 12, 13, 14].map((h) => row({ local_hour: h, score: 70 })),
    ];
    const days = summarizeHistory(rows);
    expect(days[0].hours).toBe(6);
    expect(days[0].partial).toBe(false);
    expect(days[0].airHighF).toBe(90); // the unscored row's reading still counts toward the high
  });
});

describe("summarizeHistory — best/worst hour ties within a day resolve to the earlier hour", () => {
  it("resolves ties to the earlier hour", () => {
    const rows = [
      row({ local_hour: 9, score: 90 }),
      row({ local_hour: 15, score: 90 }), // tied best — 9 AM should win
      row({ local_hour: 10, score: 40 }),
      row({ local_hour: 16, score: 40 }), // tied worst — 10 AM should win
    ];
    const days = summarizeHistory(rows);
    expect(days[0].best).toEqual({ score: 90, localHour: 9 });
    expect(days[0].worst).toEqual({ score: 40, localHour: 10 });
  });
});

describe("summarizeHistory — caps dedupe", () => {
  it("distinct caps across the day's hours, alphabetical, no duplicates", () => {
    const rows = [
      row({ local_hour: 9, caps_json: JSON.stringify(["Red flag", "High UV"]) }),
      row({ local_hour: 10, caps_json: JSON.stringify(["Red flag"]) }), // repeat — must not duplicate
      row({ local_hour: 11, caps_json: JSON.stringify(["Rip current"]) }),
      row({ local_hour: 12, caps_json: null }),
    ];
    const days = summarizeHistory(rows);
    expect(days[0].caps).toEqual(["High UV", "Red flag", "Rip current"]);
  });

  it("a day with no caps anywhere gets an empty array, not undefined", () => {
    const days = summarizeHistory([row({ caps_json: "[]" })]);
    expect(days[0].caps).toEqual([]);
  });
});

describe("summarizeHistory — timezone: local_date/local_hour are trusted verbatim", () => {
  it("groups and labels purely off local_date/local_hour, never re-derives from hour_utc", () => {
    // Two rows whose hour_utc values are 23 hours apart but whose stored
    // local_date/local_hour say they're the SAME beach-local hour+day (as
    // can legitimately happen once around a DST fall-back — see
    // lib/history/archive.ts localHourParts). The summarizer must trust the
    // stored fields outright rather than recomputing anything from hour_utc.
    const rows = [
      row({ hour_utc: "2026-11-01T05:30:00.000Z", local_date: "2026-11-01", local_hour: 1, score: 60 }),
      row({ hour_utc: "2026-11-01T06:30:00.000Z", local_date: "2026-11-01", local_hour: 1, score: 65 }),
    ];
    const days = summarizeHistory(rows);
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe("2026-11-01");
    // Both rows read as local_hour 1 — a tie broken by row/array order, not
    // by their very different hour_utc values.
    expect(days[0].best).toEqual({ score: 65, localHour: 1 });
    // Each hourly entry still carries its OWN distinct hourUtc, so a caller
    // keying a list on it (React keys, the sr-only list) never collides —
    // the whole point of keying on hourUtc instead of localHour.
    expect(days[0].hourly.map((h) => h.hourUtc)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
  });

  it("a row whose hour_utc falls on a different UTC calendar day than local_date is still grouped by local_date", () => {
    // 9 PM local in a UTC+ zone rolls into the next UTC day — local_date must win.
    const r = row({
      hour_utc: "2026-09-23T02:00:00.000Z", // UTC Sept 23
      local_date: "2026-09-22", // but still Sept 22 beach-local (e.g. UTC-4, 10 PM)
      local_hour: 22,
      timezone: "America/New_York",
    });
    const days = summarizeHistory([r]);
    expect(days[0].date).toBe("2026-09-22");
    expect(days[0].best?.localHour).toBe(22);
  });
});

describe("summarizeHistory — day-level aggregates", () => {
  it("computes highs/maxes/peaks and a representative water average", () => {
    const rows = [
      row({ local_hour: 8, air_temp_f: 80, water_temp_f: 83, sand_temp_f: 90, surf_ft: 1.5, crowd_pct: 20, seaweed_pct: 2 }),
      row({ local_hour: 14, air_temp_f: 87, water_temp_f: 85, sand_temp_f: 137, surf_ft: 3.2, crowd_pct: 40, seaweed_pct: 5 }),
      row({ local_hour: 18, air_temp_f: 82, water_temp_f: 84, sand_temp_f: 100, surf_ft: 2.0, crowd_pct: 10, seaweed_pct: 1 }),
    ];
    const days = summarizeHistory(rows);
    const d = days[0];
    expect(d.airHighF).toBe(87);
    expect(d.waterF).toBe(84); // (83+85+84)/3 = 84
    expect(d.sandMaxF).toBe(137);
    expect(d.surfMaxFt).toBe(3.2);
    expect(d.crowdPeakPct).toBe(40);
    expect(d.seaweedMaxPct).toBe(5);
  });

  it("a field with no data anywhere that day reads null, not 0", () => {
    const days = summarizeHistory([row({ crowd_pct: null, water_temp_f: null })]);
    expect(days[0].crowdPeakPct).toBeNull();
    expect(days[0].waterF).toBeNull();
  });

  it("surfMaxFt comes from surf_ft ONLY — wave_ft never substitutes for it", () => {
    // wave_ft is set (raw Hs) but surf_ft is null on every row (pre-migration
    // 0010 data) — surfMaxFt must read null, never fall back to wave_ft.
    const days = summarizeHistory([row({ wave_ft: 4.5, surf_ft: null })]);
    expect(days[0].surfMaxFt).toBeNull();
  });

  it("hourly carries every SCORED hour with its own hourUtc, ascending by localHour, skipping unscored ones", () => {
    const rows = [
      row({ local_hour: 14, hour_utc: "2026-09-22T18:00:00.000Z", score: 90 }),
      row({ local_hour: 8, hour_utc: "2026-09-22T12:00:00.000Z", score: 60 }),
      row({ local_hour: 11, hour_utc: "2026-09-22T15:00:00.000Z", score: null }), // no score — excluded
    ];
    const days = summarizeHistory(rows);
    expect(days[0].hourly).toEqual([
      { localHour: 8, hourUtc: "2026-09-22T12:00:00.000Z", score: 60 },
      { localHour: 14, hourUtc: "2026-09-22T18:00:00.000Z", score: 90 },
    ]);
  });
});

describe("summarizeHistory — multi-day ordering", () => {
  it("orders days ascending by date regardless of input order", () => {
    const rows = [
      row({ local_date: "2026-09-24", local_hour: 10 }),
      row({ local_date: "2026-09-22", local_hour: 10 }),
      row({ local_date: "2026-09-23", local_hour: 10 }),
    ];
    const days = summarizeHistory(rows);
    expect(days.map((d) => d.date)).toEqual(["2026-09-22", "2026-09-23", "2026-09-24"]);
  });
});

// --- recordsFromRows: maps the store's raw kind-tagged UNION rows into the
// API's friendly shape. The SQL itself already picked the winning row per
// kind (ORDER BY/LIMIT 1) — this is a thin, pure mapping step.
describe("recordsFromRows", () => {
  it("maps every kind present into its friendly field", () => {
    const out = recordsFromRows([
      recordRow({ kind: "best", local_date: "2026-09-26", local_hour: 14, value: 88 }),
      recordRow({ kind: "hottest_sand", local_date: "2026-09-26", local_hour: 14, value: 137 }),
      recordRow({ kind: "biggest_surf", local_date: "2026-09-27", local_hour: 12, value: 3.2 }),
      recordRow({ kind: "quietest", local_date: "2026-09-28", local_hour: 10, value: 15 }),
    ]);
    expect(out.bestDay).toEqual({ date: "2026-09-26", score: 88, localHour: 14, engineVersion: "test-1" });
    expect(out.hottestSand).toEqual({ date: "2026-09-26", sandTempF: 137, localHour: 14 });
    expect(out.biggestSurf).toEqual({ date: "2026-09-27", surfFt: 3.2, localHour: 12 });
    expect(out.quietestDay).toEqual({ date: "2026-09-28", crowdPct: 15, localHour: 10 });
  });

  it("a kind that's absent from the rows maps to null, never a fabricated value", () => {
    const out = recordsFromRows([recordRow({ kind: "best", value: 80 })]);
    expect(out.bestDay).not.toBeNull();
    expect(out.hottestSand).toBeNull();
    expect(out.biggestSurf).toBeNull();
    expect(out.quietestDay).toBeNull();
  });

  it("an empty row list maps to every field null", () => {
    const out = recordsFromRows([]);
    expect(out).toEqual({ bestDay: null, hottestSand: null, biggestSurf: null, quietestDay: null });
  });
});

// --- Scoring-formula versions ---------------------------------------------
// A drop in the chart can be a formula change, not weather. Each day says
// which formula scored it, and the response names the changes in range.
describe("summarizeHistory — engine versions per day", () => {
  it("a day with one formula lists it once and is not mixed", () => {
    const [d] = summarizeHistory([
      row({ hour_utc: "2026-10-07T14:00:00.000Z", local_date: "2026-10-07", engine_version: "2026-10-06.1" }),
      row({ hour_utc: "2026-10-07T15:00:00.000Z", local_date: "2026-10-07", engine_version: "2026-10-06.1" }),
    ]);
    expect(d.engineVersions).toEqual(["2026-10-06.1"]);
    expect(d.mixedVersions).toBe(false);
  });

  it("a day a change landed on lists both versions, oldest first, and is mixed", () => {
    const [d] = summarizeHistory([
      row({ hour_utc: "2026-10-09T18:00:00.000Z", local_date: "2026-10-09", local_hour: 14, engine_version: "2026-10-09.1" }),
      row({ hour_utc: "2026-10-09T14:00:00.000Z", local_date: "2026-10-09", local_hour: 10, engine_version: "2026-10-06.1" }),
      row({ hour_utc: "2026-10-09T19:00:00.000Z", local_date: "2026-10-09", local_hour: 15, engine_version: "2026-10-09.1" }),
    ]);
    expect(d.engineVersions).toEqual(["2026-10-06.1", "2026-10-09.1"]);
    expect(d.mixedVersions).toBe(true);
  });

  it("each day keeps its own versions", () => {
    const days = summarizeHistory([
      row({ hour_utc: "2026-10-08T14:00:00.000Z", local_date: "2026-10-08", engine_version: "2026-10-06.1" }),
      row({ hour_utc: "2026-10-10T14:00:00.000Z", local_date: "2026-10-10", engine_version: "2026-10-09.1" }),
    ]);
    expect(days.map((d) => d.engineVersions)).toEqual([["2026-10-06.1"], ["2026-10-09.1"]]);
    expect(days.every((d) => !d.mixedVersions)).toBe(true);
  });
});

describe("summarizeVersions — boundaries inside the range", () => {
  const CUR = "2026-10-09.1";
  const day = (date: string, versions: string[]) =>
    summarizeHistory(
      versions.map((v, i) =>
        row({ hour_utc: `${date}T1${i}:00:00.000Z`, local_date: date, local_hour: 10 + i, engine_version: v }),
      ),
    )[0];

  it("a range on one formula has no boundary and is not mixed", () => {
    const v = summarizeVersions([day("2026-10-09", [CUR]), day("2026-10-10", [CUR])], CUR);
    expect(v).toEqual({ current: CUR, inRange: [CUR], mixed: false, boundaries: [] });
  });

  it("names a change that falls inside the range, with its date and note", () => {
    const v = summarizeVersions([day("2026-10-07", ["2026-10-06.1"]), day("2026-10-10", [CUR])], CUR);
    expect(v.mixed).toBe(true);
    expect(v.inRange).toEqual(["2026-10-06.1", CUR]);
    expect(v.boundaries).toHaveLength(1);
    expect(v.boundaries[0]).toMatchObject({ date: "2026-10-09", version: CUR });
    expect(v.boundaries[0].note).toMatch(/wind/i);
  });

  it("a day that straddles a change counts as crossing it", () => {
    const v = summarizeVersions([day("2026-10-09", ["2026-10-06.1", CUR])], CUR);
    expect(v.boundaries.map((b) => b.date)).toEqual(["2026-10-09"]);
  });

  it("lists every change in range, oldest first", () => {
    const v = summarizeVersions(
      [day("2026-10-01", ["2026-09-28.2"]), day("2026-10-07", ["2026-10-06.1"]), day("2026-10-10", [CUR])],
      CUR,
    );
    expect(v.boundaries.map((b) => b.version)).toEqual(["2026-10-06.1", CUR]);
  });

  it("a range that starts after a change does not name it", () => {
    const v = summarizeVersions([day("2026-10-06", ["2026-10-06.1"]), day("2026-10-08", ["2026-10-06.1"])], CUR);
    expect(v.boundaries).toEqual([]);
    expect(v.mixed).toBe(false);
    expect(v.inRange).toEqual(["2026-10-06.1"]);
  });

  it("empty days give an empty block", () => {
    expect(summarizeVersions([], CUR)).toEqual({ current: CUR, inRange: [], mixed: false, boundaries: [] });
  });

  it("an unlisted version in range does not throw and still orders by string", () => {
    const v = summarizeVersions([day("2026-10-01", ["2026-01-01.1"]), day("2026-10-10", [CUR])], CUR);
    expect(v.inRange).toEqual(["2026-01-01.1", CUR]);
    expect(v.boundaries.length).toBeGreaterThan(0);
  });
});

describe("recordsFromRows — engine version", () => {
  it("carries the best row's version into bestDay", () => {
    const out = recordsFromRows([recordRow({ kind: "best", value: 90, engine_version: "2026-10-09.1" })]);
    expect(out.bestDay?.engineVersion).toBe("2026-10-09.1");
  });
});

describe("recordsFormulaInfo", () => {
  const CUR = "2026-10-09.1";
  const bestEver = (engineVersion: string) => ({
    slug: "boca-raton",
    name: "Boca Raton",
    date: "2026-10-09",
    score: 95,
    localHour: 11,
    isThisBeach: true,
    engineVersion,
  });
  const records = (engineVersion: string | null) =>
    recordsFromRows(engineVersion ? [recordRow({ kind: "best", value: 90, engine_version: engineVersion })] : []);

  it("reports the day the current formula began", () => {
    expect(recordsFormulaInfo(records(CUR), bestEver(CUR), CUR)).toEqual({
      recordsSince: "2026-10-09",
      recordsFromEarlierFormula: false,
    });
  });

  it("flags an earlier formula when the best day comes from one", () => {
    expect(recordsFormulaInfo(records("2026-10-06.1"), bestEver(CUR), CUR).recordsFromEarlierFormula).toBe(true);
  });

  it("flags an earlier formula when only best-ever comes from one", () => {
    expect(recordsFormulaInfo(records(CUR), bestEver("2026-10-06.1"), CUR).recordsFromEarlierFormula).toBe(true);
  });

  it("no records at all is not 'earlier'", () => {
    expect(recordsFormulaInfo(records(null), null, CUR).recordsFromEarlierFormula).toBe(false);
  });

  it("recordsSince is null for a version the list does not know", () => {
    expect(recordsFormulaInfo(records(null), null, "unlisted").recordsSince).toBeNull();
  });
});
