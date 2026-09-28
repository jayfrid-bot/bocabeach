import { describe, it, expect } from "vitest";
import { shiftLocalDate, summarizeHistory, weekdayOf } from "@/lib/history/summary";
import type { BeachHourlyRow } from "@/lib/history/types";

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

describe("weekdayOf", () => {
  it("labels a known date correctly", () => {
    // 2026-09-22 is a Tuesday.
    expect(weekdayOf("2026-09-22")).toBe("Tue");
    // 2026-09-28 (today, per the app's own clock) is a Monday.
    expect(weekdayOf("2026-09-28")).toBe("Mon");
  });

  it("returns '' for a malformed date rather than throwing", () => {
    expect(weekdayOf("not-a-date")).toBe("");
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

describe("summarizeHistory — empty input", () => {
  it("returns no days and every record null", () => {
    const out = summarizeHistory([]);
    expect(out.days).toEqual([]);
    expect(out.records).toEqual({
      bestDay: null,
      hottestSand: null,
      biggestWaves: null,
      quietestDay: null,
    });
  });
});

describe("summarizeHistory — one hour", () => {
  it("a single row makes a single, partial day whose best/worst/avg all equal that one score", () => {
    const out = summarizeHistory([row({ score: 72, local_hour: 14 })]);
    expect(out.days).toHaveLength(1);
    const d = out.days[0];
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
    const out = summarizeHistory(rows);
    expect(out.days[0].hours).toBe(5);
    expect(out.days[0].partial).toBe(true);
  });

  it("a day with exactly 6 scored hours is NOT partial", () => {
    const rows = [0, 1, 2, 3, 4, 5].map((h) => row({ local_hour: h, score: 50 + h }));
    const out = summarizeHistory(rows);
    expect(out.days[0].hours).toBe(6);
    expect(out.days[0].partial).toBe(false);
  });

  it("a row with no score at all doesn't count toward 'hours' but still contributes its other fields", () => {
    const rows = [
      row({ local_hour: 8, score: null, air_temp_f: 90 }),
      ...[9, 10, 11, 12, 13, 14].map((h) => row({ local_hour: h, score: 70 })),
    ];
    const out = summarizeHistory(rows);
    expect(out.days[0].hours).toBe(6);
    expect(out.days[0].partial).toBe(false);
    expect(out.days[0].airHighF).toBe(90); // the unscored row's reading still counts toward the high
  });
});

describe("summarizeHistory — ties break to the earliest hour/date", () => {
  it("best/worst hour ties within a day resolve to the earlier hour", () => {
    const rows = [
      row({ local_hour: 9, score: 90 }),
      row({ local_hour: 15, score: 90 }), // tied best — 9 AM should win
      row({ local_hour: 10, score: 40 }),
      row({ local_hour: 16, score: 40 }), // tied worst — 10 AM should win
    ];
    const out = summarizeHistory(rows);
    expect(out.days[0].best).toEqual({ score: 90, localHour: 9 });
    expect(out.days[0].worst).toEqual({ score: 40, localHour: 10 });
  });

  it("a tied 'best day' record resolves to the earlier date", () => {
    const rows = [
      row({ local_date: "2026-09-23", local_hour: 10, score: 95 }),
      row({ local_date: "2026-09-22", local_hour: 10, score: 95 }),
    ];
    const out = summarizeHistory(rows);
    expect(out.records.bestDay).toEqual({ date: "2026-09-22", score: 95 });
  });

  it("a tied 'hottest sand' record resolves to the earlier reading (date, then row order)", () => {
    const rows = [
      row({ local_date: "2026-09-23", local_hour: 12, sand_temp_f: 130 }),
      row({ local_date: "2026-09-22", local_hour: 13, sand_temp_f: 130 }),
    ];
    const out = summarizeHistory(rows);
    expect(out.records.hottestSand).toEqual({ date: "2026-09-22", sandTempF: 130, localHour: 13 });
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
    const out = summarizeHistory(rows);
    expect(out.days[0].caps).toEqual(["High UV", "Red flag", "Rip current"]);
  });

  it("a day with no caps anywhere gets an empty array, not undefined", () => {
    const out = summarizeHistory([row({ caps_json: "[]" })]);
    expect(out.days[0].caps).toEqual([]);
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
    const out = summarizeHistory(rows);
    expect(out.days).toHaveLength(1);
    expect(out.days[0].date).toBe("2026-11-01");
    // Both rows read as local_hour 1 — a tie broken by row/array order, not
    // by their very different hour_utc values.
    expect(out.days[0].best).toEqual({ score: 65, localHour: 1 });
  });

  it("a row whose hour_utc falls on a different UTC calendar day than local_date is still grouped by local_date", () => {
    // 9 PM local in a UTC+ zone rolls into the next UTC day — local_date must win.
    const r = row({
      hour_utc: "2026-09-23T02:00:00.000Z", // UTC Sept 23
      local_date: "2026-09-22", // but still Sept 22 beach-local (e.g. UTC-4, 10 PM)
      local_hour: 22,
      timezone: "America/New_York",
    });
    const out = summarizeHistory([r]);
    expect(out.days[0].date).toBe("2026-09-22");
    expect(out.days[0].best?.localHour).toBe(22);
  });
});

describe("summarizeHistory — day-level aggregates", () => {
  it("computes highs/maxes/peaks and a representative water average", () => {
    const rows = [
      row({ local_hour: 8, air_temp_f: 80, water_temp_f: 83, sand_temp_f: 90, wave_ft: 1.5, crowd_pct: 20, seaweed_pct: 2 }),
      row({ local_hour: 14, air_temp_f: 87, water_temp_f: 85, sand_temp_f: 137, wave_ft: 3.2, crowd_pct: 40, seaweed_pct: 5 }),
      row({ local_hour: 18, air_temp_f: 82, water_temp_f: 84, sand_temp_f: 100, wave_ft: 2.0, crowd_pct: 10, seaweed_pct: 1 }),
    ];
    const out = summarizeHistory(rows);
    const d = out.days[0];
    expect(d.airHighF).toBe(87);
    expect(d.waterF).toBe(84); // (83+85+84)/3 = 84
    expect(d.sandMaxF).toBe(137);
    expect(d.waveMaxFt).toBe(3.2);
    expect(d.crowdPeakPct).toBe(40);
    expect(d.seaweedMaxPct).toBe(5);
  });

  it("a field with no data anywhere that day reads null, not 0", () => {
    const out = summarizeHistory([row({ crowd_pct: null, water_temp_f: null })]);
    expect(out.days[0].crowdPeakPct).toBeNull();
    expect(out.days[0].waterF).toBeNull();
  });

  it("hourly carries every SCORED hour, ascending by localHour, skipping unscored ones", () => {
    const rows = [
      row({ local_hour: 14, score: 90 }),
      row({ local_hour: 8, score: 60 }),
      row({ local_hour: 11, score: null }), // no score — excluded from hourly
    ];
    const out = summarizeHistory(rows);
    expect(out.days[0].hourly).toEqual([
      { localHour: 8, score: 60 },
      { localHour: 14, score: 90 },
    ]);
  });
});

describe("summarizeHistory — multi-day ordering and quietest-day record", () => {
  it("orders days ascending by date regardless of input order", () => {
    const rows = [
      row({ local_date: "2026-09-24", local_hour: 10 }),
      row({ local_date: "2026-09-22", local_hour: 10 }),
      row({ local_date: "2026-09-23", local_hour: 10 }),
    ];
    const out = summarizeHistory(rows);
    expect(out.days.map((d) => d.date)).toEqual(["2026-09-22", "2026-09-23", "2026-09-24"]);
  });

  it("quietest day is the lowest daily PEAK crowd, only among days with any crowd data", () => {
    const rows = [
      row({ local_date: "2026-09-22", local_hour: 10, crowd_pct: 60 }),
      row({ local_date: "2026-09-23", local_hour: 10, crowd_pct: 15 }),
      row({ local_date: "2026-09-24", local_hour: 10, crowd_pct: null }), // no cam data this day — excluded
    ];
    const out = summarizeHistory(rows);
    expect(out.records.quietestDay).toEqual({ date: "2026-09-23", crowdPct: 15 });
  });

  it("quietestDay is null when no day has any crowd data at all", () => {
    const out = summarizeHistory([row({ crowd_pct: null })]);
    expect(out.records.quietestDay).toBeNull();
  });
});
